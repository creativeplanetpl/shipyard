import "@mantine/core/styles.css";
import "./panel.css";
import { createTheme, MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const theme = createTheme({ primaryColor: "gray", defaultRadius: "md", fontFamily: "Segoe UI, system-ui, sans-serif" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <App />
    </MantineProvider>
  </StrictMode>,
);
