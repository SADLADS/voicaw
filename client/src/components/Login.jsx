import React, { useState } from 'react';
import '../assets/css/login.css';
import api from '../utils/api';
import * as opaque from "@serenity-kit/opaque";
import { generateECDSA_P256_PEM, encryptPrivateKey, decryptPrivateKey } from '../services/encryptionService';

export default function Login({ onLoginSuccess }) {
  const [loginData, setLoginData] = useState({ username: '', password: '' });
  const [registerData, setRegisterData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    try {
      const password = loginData.password;
      const username = loginData.username;
      if (!username || !password) {
        throw new Error('Username and password are required');
      }
      const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
        password,
      });

      const response1 = await api.post('/initiatelogin', { clientLoginState, startLoginRequest, userIdentifier: username });
      const loginResponse = response1.data.loginResponse;
      const loginResult = opaque.client.finishLogin({
        clientLoginState,
        loginResponse,
        password,
      });
      if (!loginResult) {
        throw new Error("Login failed");
      }
      const { finishLoginRequest, sessionKey } = loginResult;

      const response2 = await api.post('/finaliselogin', { finishLoginRequest, clientSessionKey: sessionKey, userIdentifier: username });

      if (response2.data.error) throw new Error(response2.data.error || 'Login failed');
      if (response2.data.token && response2.data.private_key) {
        const privateKey = await decryptPrivateKey(response2.data.private_key, password);
        localStorage.setItem('privateKey', privateKey); // Save decrypted private key - fix this later
        localStorage.setItem('token', response2.data.token); // Save JWT
        onLoginSuccess(response2.data); // Pass user info to parent
      } else {
        throw new Error('No token or private key received');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    try {
      const password = registerData.password;
      const username = registerData.username;
      if (!username || !password) {
        throw new Error('Username and password are required');
      }
      const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });

      const { publicPEM, privatePEM } = await generateECDSA_P256_PEM();

      const encryptedPrivatePEM = await encryptPrivateKey(privatePEM, password);



      const response1 = await api.post('/initiateregister', { userIdentifier: username, registrationRequest: registrationRequest });
      console.log(response1)
      if (response1.data.error) throw new Error(response1.data.error || 'Registration failed');
      console.log("Registration response:", response1.data);
      const registrationResponse = response1.data.registrationResponse;
      const { registrationRecord } = opaque.client.finishRegistration({
        clientRegistrationState,
        registrationResponse,
        password,
      });
      console.log("Registration record:", registrationRecord);

      const response2 = await api.post('/finaliseregister', { registrationRecord, userIdentifier: username, publicKey: publicPEM, encryptedPrivateKey: encryptedPrivatePEM });

      console.log("Token data:", response2.data);

      if (response2.data.token) {
        localStorage.setItem('privateKey', privatePEM); // Save decrypted private key - fix this later?
        localStorage.setItem('token', response2.data.token);
        onLoginSuccess(response2.data);
      } else {
        alert('Registered! You can now log in.');
      }
    } catch (err) {
      setError(err.message);
    }
  }






  return (
    <div className="form-container">
      <h3 className="login-header text-center mb-3">Voicaw Login</h3>

      {error && <div style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}

      <form onSubmit={handleLogin} className="mb-3">
        <input
          name="username"
          className="form-control mb-2"
          placeholder="Username"
          required
          value={loginData.username}
          onChange={e => setLoginData({ ...loginData, username: e.target.value })}
        />
        <input
          type="password"
          name="password"
          className="form-control mb-2"
          placeholder="Password"
          required
          value={loginData.password}
          onChange={e => setLoginData({ ...loginData, password: e.target.value })}
        />
        <button className="btn btn-vc w-100" type="submit">Login</button>
      </form>

      <hr />

      <form onSubmit={handleRegister}>
        <input
          name="username"
          className="form-control mb-2"
          placeholder="New Username"
          required
          value={registerData.username}
          onChange={e => setRegisterData({ ...registerData, username: e.target.value })}
        />
        <input
          type="password"
          name="password"
          className="form-control mb-2"
          placeholder="New Password"
          required
          value={registerData.password}
          onChange={e => setRegisterData({ ...registerData, password: e.target.value })}
        />
        <button className="btn btn-secondary w-100" type="submit">Register</button>
      </form>
    </div>
  );
}
