import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary, installGlobalErrorHandlers } from "./components/ErrorBoundary";
import "./styles.css";

installGlobalErrorHandlers();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
