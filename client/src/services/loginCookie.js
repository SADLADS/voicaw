import api from '../utils/api';
import { cookieMode, loginRejected, sameSaved, savedLogin, saveLogin } from '../utils/loginToken';

// A device logged in before logins moved into the HttpOnly cookie (2026-11-20) still has its
// token in localStorage: on the built-in server it's moved into the cookie (POST
// /session-cookie, the same session) and the token forgotten. Out of reach, it stays as it is
// and is tried again next start; the server refusing the login is left to the request after
// (AuthProvider's /profile), which logs out.
export async function moveLoginToCookie() {
  const login = savedLogin();
  if (!login?.token || !cookieMode()) return;
  try {
    const { data } = await api.post('/session-cookie', null, { login, timeout: 10000 });
    // Not if someone logged in or out meanwhile (another tab).
    if (data?.login && sameSaved(savedLogin(), login)) saveLogin({ login: data.login });
  } catch (err) {
    if (!loginRejected(err)) console.warn('Could not move the login into the cookie yet');
  }
}
