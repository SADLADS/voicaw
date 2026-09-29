import React, { useState, useContext } from "react";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from '../contexts';
import NotificationSettings from "./NotificationSettings";
import AppUpdateSettings from "./AppUpdateSettings";
import { MAX_PROFILE_PIC_BYTES, uploadProfilePicture } from '../services/profileService';

export default function Settings({ onLogout }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const { interactionMode, setInteractionMode } = useContext(InteractionContext);

  const handleFileSelect = (e) => {
    const f = e.target.files[0];
    if (!f || !f.type.startsWith("image/")) {
      setError("Only image files are allowed.");
    } else if (f.size > MAX_PROFILE_PIC_BYTES) {
      setError("That image is too large (max 8 MB).");
    } else {
      setFile(f);
      setError(null);
    }
  };

  const uploadFile = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setSuccess(false);

    try {
      await uploadProfilePicture(file);
      setSuccess(true);
      setFile(null);
    } catch (err) {
      setError(err.message || "Upload error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="settings-page">
      <h2 className="settings-header">User Settings</h2>
      <div className="settings-card">
        <h5>Change Profile Pic</h5>
        <input
          type="file"
          accept="image/*"   // allow any image type
          onChange={handleFileSelect}
          style={{ marginBottom: "1rem" }}
        />
        <br />
        <button
          className="uploadbutton btn"
          onClick={uploadFile}
          disabled={!file || uploading}
          style={{
            cursor: uploading ? "not-allowed" : "pointer",
          }}
        >
          {uploading ? "Uploading..." : "Upload"}
        </button>
        {error && <p style={{ color: "red" }}>{error}</p>}
        {success && <p style={{ color: "green" }}>Upload successful!</p>}
      </div>
      <div className="settings-card">
        <h5>Interaction Mode</h5>
        <select
          value={interactionMode}
          onChange={(e) => setInteractionMode(e.target.value)}
        >
          <option value="desktop">Desktop</option>
          <option value="mobile">Mobile</option>
          <option value="auto">Auto</option>
        </select>
      </div>
      <NotificationSettings />
      <AppUpdateSettings />
      <div className="settings-card">
        <h5>About</h5>
        <p className="settings-attribution">
          Emoji graphics by <a href="https://github.com/jdecked/twemoji" target="_blank" rel="noreferrer">Twemoji</a>,
          {' '}© Twitter, Inc and other contributors, licensed under{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC-BY 4.0</a>.
        </p>
      </div>
      <div className="settings-card">
        <h5>Log Out</h5>
        <div className="mt-auto mb-4">
          <button onClick={onLogout} className="btn btn-sm btn-danger" title="Logout">
            <FontAwesomeIcon icon={faSignOutAlt} />Log out
          </button>
        </div>
      </div>
    </div>
  );
}
