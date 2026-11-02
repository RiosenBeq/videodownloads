import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { Popup } from './Popup';

// Opened as a normal tab (e.g. popup.html?tabId=123) rather than the toolbar popup.
if (new URLSearchParams(location.search).has('tabId')) document.body.classList.add('standalone');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
