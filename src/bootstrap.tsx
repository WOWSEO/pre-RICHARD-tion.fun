import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { SolanaWalletProvider } from "./wallet/SolanaProvider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SolanaWalletProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </SolanaWalletProvider>
  </React.StrictMode>
);
