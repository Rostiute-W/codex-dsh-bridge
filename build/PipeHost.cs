using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Diagnostics;
using System.Runtime.InteropServices;

// ACL is protected and grants only the current user. No network listener is used.
class PipeHost {
  static readonly object stdoutLock = new object();
  static readonly ConcurrentDictionary<string, StreamWriter> clients = new ConcurrentDictionary<string, StreamWriter>();
  static volatile bool stopping;
  static JavaScriptSerializer Json() { var j = new JavaScriptSerializer(); j.MaxJsonLength = 8 * 1024 * 1024; return j; }
  static void Emit(object value) { lock(stdoutLock) { Console.Out.WriteLine(Json().Serialize(value)); Console.Out.Flush(); } }
  static string ReadLineBounded(StreamReader reader) {
    var text = new StringBuilder(); int value;
    while ((value = reader.Read()) != -1) {
      if (value == 10) return text.ToString().TrimEnd('\r');
      if (text.Length >= 8 * 1024 * 1024) throw new IOException("Message exceeds limit");
      text.Append((char)value);
    }
    return text.Length == 0 ? null : text.ToString();
  }
  static void Serve(NamedPipeServerStream stream) {
    var id = Guid.NewGuid().ToString();
    try {
      var reader = new StreamReader(stream, new UTF8Encoding(false));
      var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
      clients[id] = writer;
      string line;
      while (!stopping && (line = ReadLineBounded(reader)) != null) Emit(new { client = id, payload = line });
    } catch (IOException) {} catch (ObjectDisposedException) {}
    finally { StreamWriter old; clients.TryRemove(id, out old); stream.Dispose(); }
  }
  static int Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length == 1 && args[0] == "--run") return RunJob();
    var sid = WindowsIdentity.GetCurrent().User;
    if (args.Length == 1 && args[0] == "--identity") { Console.WriteLine(sid.Value); return 0; }
    if (args.Length != 1 || !args[0].StartsWith("codex-dsh-")) return 2;
    var security = new PipeSecurity();
    security.SetAccessRuleProtection(true, false);
    security.SetOwner(sid);
    security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
    var responses = new Thread(() => {
      try {
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = ReadLineBounded(input)) != null) {
          var data = Json().Deserialize<Dictionary<string, object>>(line);
          StreamWriter writer;
          if (clients.TryGetValue((string)data["client"], out writer)) {
            lock(writer) { try { writer.WriteLine((string)data["payload"]); } catch (IOException) {} catch (ObjectDisposedException) {} }
          }
        }
      } catch (Exception) {} finally { stopping = true; Environment.Exit(0); }
    });
    responses.IsBackground = true;
    responses.Start();
    bool ready = false;
    try {
      while (!stopping) {
        var stream = new NamedPipeServerStream(args[0], PipeDirection.InOut, 16, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security);
        if (!ready) { Emit(new { ready = true, sid = sid.Value }); ready = true; }
        stream.WaitForConnection();
        ThreadPool.QueueUserWorkItem(_ => Serve(stream));
      }
    } catch (Exception e) { Console.Error.WriteLine(e.GetType().Name); return 1; }
    return 0;
  }

  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[]{' ', '\t', '"'}) < 0) return value;
    var b = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') b.Append('\\', slashes * 2 + 1);
      else b.Append('\\', slashes);
      b.Append(c); slashes = 0;
    }
    b.Append('\\', slashes * 2); b.Append('"'); return b.ToString();
  }
  static int RunJob() {
    var parentInput = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var spec = Json().Deserialize<Dictionary<string, object>>(ReadLineBounded(parentInput));
    var start = new ProcessStartInfo((string)spec["file"]) { UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true, StandardOutputEncoding=new UTF8Encoding(false), StandardErrorEncoding=new UTF8Encoding(false) };
    var values = (System.Collections.IEnumerable)spec["args"];
    var arguments = new List<string>(); foreach (string value in values) arguments.Add(Quote(value));
    start.Arguments = spec.ContainsKey("rawArguments") ? (string)spec["rawArguments"] : String.Join(" ", arguments.ToArray());
    if (spec.ContainsKey("cwd") && spec["cwd"] != null) start.WorkingDirectory = (string)spec["cwd"];
    start.EnvironmentVariables.Clear();
    foreach (var pair in (Dictionary<string, object>)spec["env"]) if (pair.Value != null) start.EnvironmentVariables[pair.Key] = (string)pair.Value;
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return 3;
    Action closeJob = () => { var owned = Interlocked.Exchange(ref job, IntPtr.Zero); if (owned != IntPtr.Zero) CloseHandle(owned); };
    var limits = new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    int size = Marshal.SizeOf(limits); var memory = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(limits, memory, false);
    bool configured = SetInformationJobObject(job, 9, memory, (uint)size);
    Marshal.FreeHGlobal(memory);
    if (!configured) { closeJob(); return 3; }
    try {
      using (var child = Process.Start(start)) {
        if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(); throw new IOException("Cannot confine process lifetime"); }
        var parent = Process.GetProcessById(Convert.ToInt32(spec["parentPid"]));
        var lifetime = new Thread(() => { try { parent.WaitForExit(); closeJob(); } catch (Exception) { closeJob(); } });
        lifetime.IsBackground = true; lifetime.Start();
        var output = new Thread(() => child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
        var errors = new Thread(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
        output.IsBackground = true; errors.IsBackground = true; output.Start(); errors.Start();
        var input = new Thread(() => {
          try {
            string line; while ((line = ReadLineBounded(parentInput)) != null) { child.StandardInput.WriteLine(line); child.StandardInput.Flush(); }
            child.StandardInput.Close();
          } catch (Exception) { closeJob(); }
        });
        input.IsBackground = true; input.Start();
        child.WaitForExit(); output.Join(3000); errors.Join(3000);
        return child.ExitCode;
      }
    } catch (Exception e) { Console.Error.WriteLine(e.GetType().Name); return 3; }
    finally { closeJob(); }
  }
}
