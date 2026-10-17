import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './state/AuthContext';
// The two typefaces are part of the app (served from our own address, cached for a year) — nothing is fetched from Google to draw the first screen.
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-700.css';
import '@fontsource/barlow/latin-ext-400.css';
import '@fontsource/barlow/latin-ext-500.css';
import '@fontsource/barlow/latin-ext-700.css';
import '@fontsource/barlow-condensed/latin-400.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-ext-400.css';
import '@fontsource/barlow-condensed/latin-ext-600.css';
import './styles/tokens.css';
import './styles/login.css';
import './styles/layout.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
