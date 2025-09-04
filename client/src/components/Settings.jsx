import React, { useState, useCallback } from "react";
import api from "../utils/api";

export default function Settings({ user }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleFileSelect = useCallback((e) => {
    const f = e.target.files[0];
    if (f && f.type === "image/png") {
      setFile(f);
      setError(null);
    } else {
      setError("Only PNG images are allowed.");
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.type === "image/png") {
      setFile(f);
      setError(null);
    } else {
      setError("Only PNG images are allowed.");
    }
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
      <h4>Change Profile Pic</h4>
      <input
        type="file"
        accept="image/png"
        onChange={handleFileSelect}
        style={{ marginBottom: "1rem" }}
      />
    <br></br>
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
  );
}
