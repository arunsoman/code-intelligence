// Single bundle entry for the a11y audit: one react copy so hooks work under react-dom/server.
export { App } from "../src/App.tsx";
export { auditContrast, auditMarkup, renderApp } from "../src/a11y.ts";
