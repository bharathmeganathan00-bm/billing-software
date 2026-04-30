import { useEffect, useState } from "react";
import Login from "./Login.jsx";
import POS from "./POS.jsx";
import { setAuthToken } from "./api.js";

export default function App() {
  const [session, setSession] = useState(() => {
    const saved = sessionStorage.getItem("pos-session");
    if (saved) {
      const parsed = JSON.parse(saved);
      setAuthToken(parsed.token);
      return parsed;
    }
    return null;
  });

  useEffect(() => {
    setAuthToken(session?.token);
    if (session) {
      sessionStorage.setItem("pos-session", JSON.stringify(session));
    } else {
      sessionStorage.removeItem("pos-session");
    }
  }, [session]);

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  return <POS session={session} onLogout={() => setSession(null)} />;
}
