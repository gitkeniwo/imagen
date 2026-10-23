import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Login from "./pages/Login";
import { RemoteProvider } from "./remote";
import { I18nProvider } from "./i18n";
import { ToastProvider } from "./components/Toast";
import { ConfirmProvider } from "./components/ConfirmDialog";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          {/* /login is served on the LAN listener without a session. */}
          {location.pathname === "/login" ? (
            <Login />
          ) : (
            <RemoteProvider>
              <App />
            </RemoteProvider>
          )}
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  </React.StrictMode>,
);
