using System;
using System.IO;
using System.Web.Script.Serialization;

// Test executable: no network, no model calls. Exercises the actual child-process boundary.
class MockReviewer {
  static int Main(string[] args) {
    var json = new JavaScriptSerializer();
    string report = null, model = null;
    for (int i = 0; i + 1 < args.Length; i++) {
      if (args[i] == "-o") report = args[i + 1];
      if (args[i] == "-m") model = args[i + 1];
    }
    string prompt = Console.In.ReadToEnd();
    string key = Environment.GetEnvironmentVariable("CODEX_API_KEY");
    string home = Environment.GetEnvironmentVariable("CODEX_HOME");
    if (report == null || key == null || home == null || !prompt.Contains("Review this implementation")) return 7;
    File.WriteAllText(Path.Combine(home, "mock-invocation.json"), json.Serialize(new { args, home, keyPresent=true, guidancePresent=prompt.Contains("native-guidance-test") }));
    // Deliberately emit a key across writes: logs must buffer before scrubbing.
    Console.Error.Write(key.Substring(0, key.Length / 2)); Console.Error.Flush();
    System.Threading.Thread.Sleep(80);
    Console.Error.WriteLine(key.Substring(key.Length / 2));
    if (model == "mock-failure") return 9;
    if (model != "mock-no-report") File.WriteAllText(report, json.Serialize(new {
      verdict = model == "mock-changes" ? "changes_requested" : "approved",
      summary = "Mock review complete. " + key,
      issues = model == "mock-changes" ? new [] { "Recheck expected content" } : new string[0]
    }));
    Console.WriteLine(json.Serialize(new { type="turn.completed", usage=new { input_tokens=42, output_tokens=10 } }));
    return 0;
  }
}
