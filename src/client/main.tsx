import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// PWA: instalacja na telefonie / komputerze. Service worker buforuje tylko pliki
// aplikacji — dane (API) zawsze pobierane są na żywo, żeby nie pokazywać starych kwot.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker:', e));
  });
}
