import React, { useState } from 'react';
import '../assets/css/login.css';
import api from '../utils/api';
import * as opaque from "@serenity-kit/opaque";


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

      if (response2.data.token) {
        localStorage.setItem('token', response2.data.token); // Save JWT
        onLoginSuccess(response2.data); // Pass user info to parent
      } else {
        throw new Error('No token received');
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

      const { publicKey, privateKey } = await generateKeyPair();
      console.log("Generated keys:", publicKey, privateKey);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));

      const encryptedPrivateKey = await encryptPrivateKey(privateKey, password, salt, iv);

      const publicKeyBase64 = arrayBufferToBase64(publicKey);
      const encryptedPrivateKeyBase64 = arrayBufferToBase64(encryptedPrivateKey);
      const saltBase64 = arrayBufferToBase64(salt);
      const ivBase64 = arrayBufferToBase64(iv);

      const response2 = await api.post('/finaliseregister', { registrationRecord, userIdentifier: username, publicKey: publicKeyBase64, encryptedPrivateKey: encryptedPrivateKeyBase64, salt: saltBase64, iv: ivBase64 });

      console.log("real privateKey", arrayBufferToBase64(privateKey)); //delete this line in production

      console.log("Token data:", response2.data);
      console.log("encrypted Private key:", encryptedPrivateKeyBase64);



      if (response2.data.token) {
        localStorage.setItem('privateKey', privateKey);
        localStorage.setItem('token', response2.data.token);
        onLoginSuccess(response2.data);
      } else {
        alert('Registered! You can now log in.');
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }


  async function generateKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"]
    );
    const publicKey = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    return { publicKey, privateKey };
  }


  async function encryptPrivateKey(privateKey, password, salt, iv) {
    const key = await deriveKey(password, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      privateKey
    );
    const encryptedPrivateKey = new Uint8Array(encrypted);
    return encryptedPrivateKey;
  }

  async function decryptPrivateKey(encryptedPrivateKey, password, salt, iv) {
    const key = await deriveKey(password, salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encryptedPrivateKey
    );
    return new Uint8Array(decrypted);
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
