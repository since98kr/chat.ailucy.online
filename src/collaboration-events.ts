import type { StreamEvent } from '../shared/contracts';

const collaborationEvents = new EventTarget();

export function emitCollaborationEvent(event: StreamEvent) {
  collaborationEvents.dispatchEvent(new CustomEvent<StreamEvent>('stream-event', { detail: event }));
}

export function subscribeCollaborationEvents(listener: (event: StreamEvent) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<StreamEvent>).detail);
  collaborationEvents.addEventListener('stream-event', handler);
  return () => collaborationEvents.removeEventListener('stream-event', handler);
}
