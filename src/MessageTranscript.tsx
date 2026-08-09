import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, LoaderCircle, X } from 'lucide-react';
import type { RunTranscript, TranscriptTone } from './run-transcript';

const toneColor: Record<TranscriptTone, string> = {
  pending: 'rgba(148, 163, 184, 0.85)',
  running: 'rgba(96, 165, 250, 0.95)',
  success: 'rgba(74, 222, 128, 0.95)',
  error: 'rgba(248, 113, 113, 0.95)',
  muted: 'rgba(148, 163, 184, 0.6)',
};

const containerStyle: CSSProperties = {
  marginTop: 10,
  border: '1px solid rgba(148, 163, 184, 0.22)',
  borderRadius: 10,
  overflow: 'hidden',
};

const toggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '6px 10px',
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  font: 'inherit',
  fontSize: 10,
  letterSpacing: 0.2,
  opacity: 0.8,
  cursor: 'pointer',
  textAlign: 'left',
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '2px 10px 8px',
  margin: 0,
  listStyle: 'none',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  fontSize: 10,
  lineHeight: 1.5,
};

const detailStyle: CSSProperties = { opacity: 0.6 };

function ToneIcon({ tone }: { tone: TranscriptTone }) {
  const color = toneColor[tone];
  if (tone === 'running') {
    return <LoaderCircle size={11} color={color} style={{ flexShrink: 0, marginTop: 2 }} />;
  }
  if (tone === 'success') {
    return <Check size={11} color={color} style={{ flexShrink: 0, marginTop: 2 }} />;
  }
  if (tone === 'error') {
    return <X size={11} color={color} style={{ flexShrink: 0, marginTop: 2 }} />;
  }
  return <Circle size={11} color={color} style={{ flexShrink: 0, marginTop: 2 }} />;
}

const statusSummary: Record<RunTranscript['status'], string> = {
  running: '실행 중',
  paused: '일시중지',
  completed: '완료',
  failed: '실패',
  cancelled: '취소됨',
};

export function MessageTranscript({ transcripts }: { transcripts: RunTranscript[] }) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const active = transcripts.filter((run) => run.entries.length > 0);
  // Keep an in-flight run open so the user can watch it; collapse finished ones.
  const hasRunning = active.some((run) => run.status === 'running');
  if (active.length === 0) return null;

  const open = openOverride ?? hasRunning;
  const stepCount = active.reduce((total, run) => total + run.entries.length, 0);
  const worst: RunTranscript['status'] = active.some((run) => run.status === 'failed')
    ? 'failed'
    : hasRunning
      ? 'running'
      : active[active.length - 1].status;

  return (
    <div style={containerStyle} className="message-transcript">
      <button
        type="button"
        style={toggleStyle}
        onClick={() => setOpenOverride(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>실행 단계 {stepCount}개 · {statusSummary[worst]}</span>
      </button>
      {open ? (
        <ul style={listStyle}>
          {active.map((run) => run.entries.map((entry) => (
            <li key={entry.id} style={rowStyle}>
              <ToneIcon tone={entry.tone} />
              <span>
                {entry.label}
                {entry.detail ? <span style={detailStyle}> — {entry.detail}</span> : null}
              </span>
            </li>
          )))}
          {active.some((run) => run.truncated) ? (
            <li style={{ ...rowStyle, ...detailStyle }}>이전 단계 일부는 표시 한도를 넘어 생략되었습니다.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export default MessageTranscript;
