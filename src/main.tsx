import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthGate from './AuthGate';
import { registerPwa } from './pwa';
import './styles.css';
import './chat-core.css';
import './giant-step-2.css';
import './auth-shell.css';
import './collaboration.css';

registerPwa();
window.addEventListener('chat-auth-required', () => window.location.reload());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
