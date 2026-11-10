// 沿用 DSH 原生对话界面，发送后只负责打开对应会话。
window.__ModuleLoader__.load({ id:'@codex-dsh/bridge', factory:() => ({
  inject:['uiWorkspace'], apply(ctx) {
    ctx.effect(() => {
      const lifetime=new AbortController();let timer,last=0;
      async function refresh() {
        try {
          const response=await fetch('/codex-dsh-bridge/native-focus',{signal:lifetime.signal,credentials:'same-origin',cache:'no-store'});
          if(!response.ok)throw new Error('DSH connector unavailable');
          const focus=await response.json();
          if(!lifetime.signal.aborted && focus.sessionId && focus.seq!==last){ctx.uiWorkspace.openSession(focus.sessionId);last=focus.seq;}
        } catch { /* Host 重连只重试读取焦点，不调用模型。 */ }
        finally {if(!lifetime.signal.aborted)timer=setTimeout(refresh,1000);}
      }
      void refresh();return ()=>{lifetime.abort();clearTimeout(timer);};
    },'bridge-native:open-conversation');
  }
}) });