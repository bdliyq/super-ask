import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initAuthToken } from "./auth";
import { I18nProvider } from "./i18n";
import App from "./App";
import "./styles/global.css";

const el = document.getElementById("root");
if (!el) {
  throw new Error("找不到 #root 挂载点");
}
const rootEl = el;

async function bootstrap() {
  await initAuthToken();
  createRoot(rootEl).render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>,
  );
}

void bootstrap();
