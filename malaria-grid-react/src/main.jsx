// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css"; // ถ้ามีไฟล์ index.css อยู่ในโปรเจกต์

// ผูก React เข้ากับ div#root ใน index.html
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
