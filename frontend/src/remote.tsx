import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { remoteApi, type SessionInfo } from "./api";

// Which listener this page came from: the Mac's own window (remote = false) or
// a LAN device. Remote pages also track whether the Mac is still reachable.
const HEARTBEAT_MS = 10_000;
const RETRY_MS = 5_000;

export interface RemoteValue {
  remote: boolean;
  hostName: string;
  device: SessionInfo["device"];
  role: SessionInfo["role"];
  canManage: boolean;
  conn: "ok" | "lost";
  // Seconds until the next automatic retry while lost.
  retryIn: number;
  retry: () => void;
  signOut: () => Promise<void>;
  // Network-level failures from any request flag the link as down immediately.
  reportNetworkError: () => void;
}

const LOCAL: RemoteValue = {
  remote: false,
  hostName: "",
  device: null,
  role: "owner",
  canManage: true,
  conn: "ok",
  retryIn: 0,
  retry: () => {},
  signOut: async () => {},
  reportNetworkError: () => {},
};

// Dev-only: `?fakeRemote=<host name>` pretends this page is a LAN device so the
// remote UI can be checked against a local dev server. Stripped from prod builds.
const FAKE_REMOTE: string | null = import.meta.env.DEV
  ? new URLSearchParams(location.search).get("fakeRemote")
  : null;
const FAKE_ROLE: SessionInfo["role"] = import.meta.env.DEV &&
  new URLSearchParams(location.search).get("fakeRole") === "admin"
  ? "admin"
  : "member";

const RemoteContext = createContext<RemoteValue>(LOCAL);

export function useRemote() {
  return useContext(RemoteContext);
}

export function RemoteProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [conn, setConn] = useState<"ok" | "lost">("ok");
  const [retryIn, setRetryIn] = useState(0);
  const nextAt = useRef(0);
  const probing = useRef(false);
  const libraryKey = useRef<string | null>(null);

  const acceptLibraryKey = useCallback((next: string | null | undefined) => {
    if (!next) return;
    if (libraryKey.current && next !== libraryKey.current) {
      location.reload();
      return;
    }
    libraryKey.current = next;
  }, []);

  useEffect(() => {
    if (FAKE_REMOTE !== null) {
      setInfo({
        remote: true,
        host_name: FAKE_REMOTE || "Whirling-In-Rags",
        device: null,
        role: FAKE_ROLE,
        library_key: "dev-library",
      });
      setLoaded(true);
      return;
    }
    // Not reachable (older backend, Docker, dev) means plain local mode.
    remoteApi
      .session()
      .then((next) => {
        setInfo(next);
        if (next.remote) acceptLibraryKey(next.library_key);
      })
      .catch(() => setInfo(null))
      .finally(() => setLoaded(true));
  }, [acceptLibraryKey]);

  const remote = !!info?.remote;

  const probe = useCallback(async () => {
    if (probing.current || FAKE_REMOTE !== null) return;
    probing.current = true;
    try {
      const next = await remoteApi.session();
      if (next.remote) acceptLibraryKey(next.library_key);
      setInfo(next);
      setConn("ok");
      nextAt.current = Date.now() + HEARTBEAT_MS;
    } catch (e) {
      // A 401 already redirected to /login; anything else is "can't reach".
      if ((e as Error).message !== "remote_auth_required") {
        setConn("lost");
      }
      nextAt.current = Date.now() + RETRY_MS;
    } finally {
      probing.current = false;
    }
  }, [acceptLibraryKey]);

  useEffect(() => {
    if (!remote) return;
    nextAt.current = Date.now() + HEARTBEAT_MS;
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((nextAt.current - Date.now()) / 1000));
      setRetryIn(left);
      if (left === 0) void probe();
    }, 1000);
    // Safari suspends timers in a backgrounded tab; check as soon as it's back.
    const onVisible = () => {
      if (document.visibilityState === "visible") void probe();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [remote, probe]);

  const retry = useCallback(() => void probe(), [probe]);
  const reportNetworkError = useCallback(() => {
    setConn("lost");
    nextAt.current = Date.now() + RETRY_MS;
  }, []);
  const signOut = useCallback(async () => {
    try {
      await remoteApi.logout();
    } finally {
      location.href = "/login";
    }
  }, []);

  if (!loaded) return null;
  const role = info?.role ?? "owner";
  const value: RemoteValue = remote
    ? {
        remote,
        hostName: info?.host_name || "Mac",
        device: info?.device ?? null,
        role,
        canManage: role !== "member",
        conn,
        retryIn,
        retry,
        signOut,
        reportNetworkError,
      }
    : LOCAL;
  return <RemoteContext.Provider value={value}>{children}</RemoteContext.Provider>;
}
