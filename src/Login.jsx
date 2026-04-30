import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import api, { setAuthToken } from "./api.js";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("1234");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function login(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await api.post("/login", { username, password });
      setAuthToken(response.data.token);
      onLogin(response.data);
    } catch (err) {
      setError(err.response?.data?.error || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <div className="login-phone login-phone-left" aria-hidden="true">
        <img src="./login-phone-left.png" alt="" />
      </div>
      <form className="login-panel" onSubmit={login}>
        <div className="brand-mark">
          <img src="./vedha-login-logo.png" alt="Vedha Mobile logo" />
        </div>
        <h1>Vedha Mobile Login</h1>
        <p>Sign in to open mobile billing, repairs, accessories, and dashboard controls.</p>

        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error ? <div className="form-error">{error}</div> : null}

        <button className="primary-button" disabled={loading}>
          <LockKeyhole size={18} />
          {loading ? "Signing in..." : "Login"}
        </button>
      </form>
      <div className="login-phone login-phone-right" aria-hidden="true">
        <img src="./login-phone-right.png" alt="" />
      </div>
    </main>
  );
}
