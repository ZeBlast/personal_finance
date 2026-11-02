import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./app/App";
import "./index.css";

// HashRouter keeps routes working both inside the Tauri window and when the same files are
// served from the backend in a browser tab, with no server-side route handling needed.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
