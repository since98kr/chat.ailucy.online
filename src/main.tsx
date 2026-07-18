import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthGate from './AuthGate';
import { registerPwa } from './pwa';
import './styles.css';
import './chat-core.css';
import './giant-step-2.css';
import './auth-shell.css';

registerPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
