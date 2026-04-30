import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

// Get Supabase credentials from environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing Supabase environment variables. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Auth functions
export async function login(username, password) {
  try {
    // Validate input
    if (!username || !password) {
      console.warn("[AUTH] Missing username or password");
      return { success: false, error: "Username and password are required" };
    }

    const { data, error } = await supabase
      .from("users")
      .select("id, username, role, password_hash, active")
      .eq("username", username)
      .eq("active", true)
      .maybeSingle();

    // Debug logging
    if (error) {
      console.error("[AUTH] Login query error:", error.message, error.code);
      return { success: false, error: "Database error. Please try again." };
    }

    // User not found
    if (!data) {
      console.warn("[AUTH] User not found:", username);
      return { success: false, error: "Invalid username or password" };
    }

    // Verify password using bcrypt
    const passwordMatch = await bcrypt.compare(password, data.password_hash);
    if (!passwordMatch) {
      console.warn("[AUTH] Invalid password for user:", username);
      return { success: false, error: "Invalid username or password" };
    }

    // Password verified - create token
    const token = btoa(JSON.stringify({ id: data.id, username: data.username, role: data.role }));
    
    console.log("[AUTH] Login successful for user:", username);
    return {
      success: true,
      token,
      user: { id: data.id, username: data.username, role: data.role }
    };
  } catch (error) {
    console.error("[AUTH] Login function error:", error);
    return { success: false, error: "An unexpected error occurred. Please try again." };
  }
}

// Helper to get auth token from storage
export function getAuthToken() {
  const session = sessionStorage.getItem("pos-session");
  if (!session) return null;
  try {
    return JSON.parse(session).token;
  } catch {
    return null;
  }
}

// Helper to get current user from token
export function getCurrentUser() {
  const session = sessionStorage.getItem("pos-session");
  if (!session) return null;
  try {
    const parsed = JSON.parse(session);
    if (parsed.user) return parsed.user;
    // Decode token if needed
    const decoded = JSON.parse(atob(parsed.token));
    return { id: decoded.id, username: decoded.username, role: decoded.role };
  } catch {
    return null;
  }
}
