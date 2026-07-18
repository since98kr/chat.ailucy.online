import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerPwa } from './pwa';
import './styles.css';
import './chat-core.css';
import './giant-step-2.css';

registerPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
