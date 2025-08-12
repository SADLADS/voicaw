function pemToArrayBuffer(pem) {
    const b64 = pem.replace(/-----.*-----/g, '').replace(/\s/g, '');
    const binary = atob(b64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
    return buffer.buffer;
}

export async function generateECDH_P256_PEM() {
    const kp = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
    );

    const pub = await crypto.subtle.exportKey("spki", kp.publicKey);
    const priv = await crypto.subtle.exportKey("pkcs8", kp.privateKey);

    const toPEM = (buf, type) => {
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);
        const lines = b64.match(/.{1,64}/g).join("\n");
        return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`;
    };

    return {
        publicPEM: toPEM(pub, "PUBLIC KEY"),
        privatePEM: toPEM(priv, "PRIVATE KEY"),
        keyPair: kp,
    };
}

export async function encryptPrivateKey(privatePEM, password) {
    const enc = new TextEncoder();

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    const key = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
    );

    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        enc.encode(privatePEM)
    );

    const combined = new Uint8Array(salt.byteLength + iv.byteLength + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.byteLength);
    combined.set(new Uint8Array(ciphertext), salt.byteLength + iv.byteLength);

    return btoa(String.fromCharCode(...combined));
}

export async function decryptPrivateKey(encryptedB64, password) {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const encryptedBytes = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));

    const salt = encryptedBytes.slice(0, 16);
    const iv = encryptedBytes.slice(16, 28);
    const data = encryptedBytes.slice(28);

    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );
    const plaintextBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        data
    );
    return dec.decode(plaintextBuffer);
}


export async function deriveSharedKey(privatePEM, otherPublicPEM) {
    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        pemToArrayBuffer(privatePEM),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveKey"]
    );

    const publicKey = await crypto.subtle.importKey(
        "spki",
        pemToArrayBuffer(otherPublicPEM),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
    );

    const derivedKey = await crypto.subtle.deriveKey(
        {
            name: "ECDH",
            public: publicKey,
        },
        privateKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );

    return derivedKey;
}

export async function encryptMessage(message, aesKey) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        aesKey,
        enc.encode(message)
    );

    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.byteLength);

    return btoa(String.fromCharCode(...combined));
}

export async function decryptMessage(encryptedB64, aesKey) {
    const dec = new TextDecoder();
    const encryptedBytes = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));

    const iv = encryptedBytes.slice(0, 12);
    const data = encryptedBytes.slice(12);

    const plaintextBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        aesKey,
        data
    );

    return dec.decode(plaintextBuffer);
}
