import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { Bot, CheckCircle2, KeyRound, LoaderCircle, LogOut, RefreshCw, Server, ShieldCheck, Sparkles, XCircle } from 'lucide-react';

type AuthMode = 'disabled' | 'token' | 'cloudflare';
type AuthSession = { authenticated: boolean; mode: AuthMode; identity: string };
type AdapterStatus = { ok: boolean; mode: string; detail: string; latencyMs: number };
type OpsStatus = {
  ok: boolean;
  build: { sha: string; version: string; builtAt: string; environment: string };
  auth: { mode: AuthMode; allowedEmailCount: number; allowedOriginCount: number };
  adapters: { letta: AdapterStatus; hermes: AdapterStatus };
  runtime: { node: string; uptimeSeconds: number; pid: number };
  timestamp: string;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function json<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  return payload as T;
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [phase, setPhase] = useState<'loading' | 'login' | 'ready' | 'denied'>('loading');
  const [message, setMessage] = useState('보안 세션을 확인하고 있습니다.');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const verify = useCallback(async () => {
    setPhase('loading');
    setMessage('보안 세션을 확인하고 있습니다.');
    try {
      const config = await json<{ mode: AuthMode }>('/api/auth/config');
      setMode(config.mode);
      if (config.mode === 'disabled') {
        const local: AuthSession = { authenticated: true, mode: 'disabled', identity: 'local' };
        setSession(local);
        setPhase('ready');
        return;
      }
      try {
        const current = await json<AuthSession>('/api/auth/session');
        setSession(current);
        setPhase('ready');
      } catch (error) {
        if (config.mode === 'token') {
          setPhase('login');
          setMessage('이 Chat V2에 접근하려면 개인 액세스 토큰을 입력하세요.');
        } else {
          setPhase('denied');
          setMessage(error instanceof Error ? error.message : 'Cloudflare Access 인증을 확인하지 못했습니다.');
        }
      }
    } catch (error) {
      setPhase('denied');
      setMessage(error instanceof Error ? error.message : 'Chat V2 서버에 연결할 수 없습니다.');
    }
  }, []);

  useEffect(() => { void verify(); }, [verify]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[aria-label="시스템 설정"]')) {
        event.preventDefault();
        setPanelOpen(true);
      }
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, []);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    try {
      const authenticated = await json<AuthSession>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim() }),
      });
      setToken('');
      setSession(authenticated);
      setPhase('ready');
    } catch (error) {
      setMessage(error instanceof Error && error.message === 'INVALID_ACCESS_TOKEN'
        ? '액세스 토큰이 올바르지 않습니다.'
        : error instanceof Error ? error.message : '로그인하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await json('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(null);
    setPanelOpen(false);
    setPhase(mode === 'token' ? 'login' : 'loading');
    if (mode !== 'token') await verify();
  };

  if (phase !== 'ready' || !session) {
    return (
      <div className="auth-page">
        <section className="auth-card" aria-live="polite">
          <div className="auth-logo"><Sparkles size={22} /></div>
          <div className="auth-title"><strong>chat.ailucy.online</strong><span>Private AI workspace</span></div>
          {phase === 'loading' && <div className="auth-progress"><LoaderCircle size={20} className="spin" /> {message}</div>}
          {phase === 'login' && (
            <form className="auth-form" onSubmit={login}>
              <div className="auth-message"><KeyRound size={18} /><span>{message}</span></div>
              <label>
                <span>개인 액세스 토큰</span>
                <input
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Token"
                />
              </label>
              <button type="submit" disabled={busy || !token.trim()}>
                {busy ? <LoaderCircle size={17} className="spin" /> : <ShieldCheck size={17} />}
                안전하게 접속
              </button>
              <small>토큰은 JavaScript 저장소에 보관하지 않고 HttpOnly 세션 쿠키로 전환됩니다.</small>
            </form>
          )}
          {phase === 'denied' && (
            <div className="auth-denied">
              <XCircle size={24} />
              <strong>접근 또는 연결을 확인할 수 없습니다.</strong>
              <p>{message}</p>
              <button onClick={() => void verify()}><RefreshCw size={16} /> 다시 확인</button>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <>
      {children}
      {panelOpen && (
        <RuntimePanel session={session} onClose={() => setPanelOpen(false)} onLogout={logout} />
      )}
    </>
  );
}

function RuntimePanel({ session, onClose, onLogout }: { session: AuthSession; onClose: () => void; onLogout: () => void }) {
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await json<OpsStatus>('/api/ops/status'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '운영 상태를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="runtime-scrim" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <aside className="runtime-panel" aria-label="시스템 상태">
        <header>
          <div><strong>System Status</strong><span>인증된 운영 정보</span></div>
          <button className="runtime-icon" onClick={onClose} aria-label="상태 패널 닫기"><XCircle size={19} /></button>
        </header>
        {loading && <div className="runtime-loading"><LoaderCircle size={18} className="spin" /> 상태를 확인하고 있습니다.</div>}
        {error && <div className="runtime-error"><XCircle size={17} /> {error}</div>}
        {status && (
          <div className="runtime-content">
            <section>
              <h3><Server size={15} /> Runtime</h3>
              <dl>
                <div><dt>Environment</dt><dd>{status.build.environment}</dd></div>
                <div><dt>Version</dt><dd>{status.build.version}</dd></div>
                <div><dt>Revision</dt><dd title={status.build.sha}>{status.build.sha.slice(0, 12)}</dd></div>
                <div><dt>Uptime</dt><dd>{Math.floor(status.runtime.uptimeSeconds / 60)} min</dd></div>
              </dl>
            </section>
            <section>
              <h3><ShieldCheck size={15} /> Session</h3>
              <dl>
                <div><dt>Mode</dt><dd>{session.mode}</dd></div>
                <div><dt>Identity</dt><dd>{session.identity}</dd></div>
              </dl>
            </section>
            <section>
              <h3><Bot size={15} /> AI Systems</h3>
              <AdapterRow name="[Letta] Lucy" status={status.adapters.letta} />
              <AdapterRow name="[Hermes] Lucy" status={status.adapters.hermes} />
            </section>
          </div>
        )}
        <footer>
          <button onClick={() => void refresh()}><RefreshCw size={15} /> 새로고침</button>
          {session.mode === 'token' && <button className="runtime-logout" onClick={() => void onLogout()}><LogOut size={15} /> 로그아웃</button>}
        </footer>
      </aside>
    </div>
  );
}

function AdapterRow({ name, status }: { name: string; status: AdapterStatus }) {
  return (
    <div className="adapter-status">
      <span className={status.ok ? 'adapter-dot adapter-dot--ok' : 'adapter-dot'} />
      <div><strong>{name}</strong><small>{status.mode} · {status.detail}</small></div>
      <em>{status.latencyMs}ms</em>
      {status.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
    </div>
  );
}
