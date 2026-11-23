import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreProvider } from '../lib/store';
import './styles.css';

if (new URLSearchParams(location.search).has('tab')) document.documentElement.classList.add('in-tab');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>
);
