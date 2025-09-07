import React, { useState, useCallback, useContext } from "react";
import api from "../utils/api";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import { InteractionContext } from "../App";


export default function Settings({ onLogout, user }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const { interactionMode, setInteractionMode } = useContext(InteractionContext);

  const validateImage = (f) => {
    if (f && f.type.startsWith("image/")) {
      setFile(f);
      setError(null);
    } else {
      setError("Only image files are allowed.");
    }
  };

  const handleFileSelect = useCallback((e) => {
    validateImage(e.target.files[0]);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    validateImage(e.dataTransfer.files[0]);
  }, []);

  const handleDragOver = (e) => e.preventDefault();

  const uploadFile = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setSuccess(false);

    try {
      const { data } = await api.get("/upload_profile_pic", {
        params: { filename: file.name, type: file.type },
      });

      const uploadUrl = data?.url;
      if (!uploadUrl) throw new Error("Invalid upload URL");

      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!res.ok) throw new Error("Upload failed");

      setSuccess(true);
      setFile(null);
    } catch (err) {
      setError(err.message || "Upload error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ padding: "2rem" }}>
      <h2>Settings</h2>
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

      <h5>Interaction Mode</h5>
      <select
        value={interactionMode}
        onChange={(e) => setInteractionMode(e.target.value)}
      >
        <option value="desktop">Desktop</option>
        <option value="mobile">Mobile</option>
        <option value="auto">Auto</option>
      </select>

      <h5>Log Out</h5>
      <div className="mt-auto mb-4">
        <button onClick={onLogout} className="btn btn-sm btn-danger" title="Logout">
          <FontAwesomeIcon icon={faSignOutAlt} />Log out
        </button>
      </div>
    </div>
  );
}
