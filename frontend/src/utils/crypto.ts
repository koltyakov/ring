// E2E Encryption utilities using Curve25519 and AES-GCM

export interface KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface EncryptedMessage {
  content: string  // base64 encoded
  nonce: string    // base64 encoded
}

const STORAGE_KEY = 'chatapp_keys'

// Check if X25519 is supported
export function isX25519Supported(): boolean {
  return typeof window !== 'undefined' && 
    window.crypto?.subtle !== undefined
}

// Generate or retrieve keys from localStorage
export async function getOrCreateKeys(): Promise<KeyPair> {
  const stored = localStorage.getItem(STORAGE_KEY)
  
  if (stored) {
    try {
      const parsed = JSON.parse(stored)
      if (parsed.publicKey && parsed.privateKey) {
        const publicKey = base64ToBytes(parsed.publicKey)
        const privateKey = base64ToBytes(parsed.privateKey)
        
        console.log('[Crypto] Found stored keys, validating...')
        
        // Validate keys are proper length
        if (publicKey.length > 0 && privateKey.length > 0) {
          // Try to validate by attempting to import the private key
          try {
            // Detect which algorithm by key size
            if (privateKey.length === 32) {
              // X25519
              await window.crypto.subtle.importKey(
                'raw',
                privateKey.buffer as ArrayBuffer,
                { name: 'X25519' },
                false,
                ['deriveKey']
              )
            } else {
              // ECDH P-256 (PKCS8 format)
              await window.crypto.subtle.importKey(
                'pkcs8',
                privateKey.buffer as ArrayBuffer,
                { name: 'ECDH', namedCurve: 'P-256' },
                false,
                ['deriveKey']
              )
            }
            console.log('[Crypto] Stored keys are valid')
            return { publicKey, privateKey }
          } catch (e) {
            console.error('[Crypto] Stored keys have incompatible format, will regenerate:', e)
          }
        } else {
          console.warn('[Crypto] Invalid key length, will regenerate')
        }
      }
    } catch (e) {
      console.warn('[Crypto] Invalid stored keys, will generate new:', e)
    }
  }

  // Clear invalid stored keys
  console.log('[Crypto] Removing old keys and generating new ones...')
  localStorage.removeItem(STORAGE_KEY)
  
  // Force logout so user has to log back in with new keys
  const token = localStorage.getItem('token')
  if (token) {
    console.warn('[Crypto] Keys regenerated - forcing logout')
    localStorage.removeItem('token')
    alert('🔑 Your encryption keys have been regenerated.\n\nYou have been logged out.\n\nPlease LOG BACK IN to sync your new keys.')
    window.location.reload()
    throw new Error('Keys regenerated - please log in again')
  }

  if (!isX25519Supported()) {
    throw new Error('Web Crypto API not supported in this browser')
  }

  try {
    console.log('[Crypto] Attempting to generate key pair...')
    
    let publicKey: Uint8Array
    let privateKey: Uint8Array
    
    // Try X25519 first (modern browsers)
    try {
      console.log('[Crypto] Trying X25519...')
      const keyPair = await window.crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveKey', 'deriveBits']
      ) as CryptoKeyPair

      const publicKeyRaw = await window.crypto.subtle.exportKey('raw', keyPair.publicKey)
      const privateKeyRaw = await window.crypto.subtle.exportKey('raw', keyPair.privateKey)

      publicKey = new Uint8Array(publicKeyRaw)
      privateKey = new Uint8Array(privateKeyRaw)
      
      console.log('[Crypto] X25519 key generation successful')
    } catch (x25519Error) {
      console.warn('[Crypto] X25519 not supported, falling back to ECDH P-256:', x25519Error)
      
      // Fallback to ECDH with P-256 (widely supported)
      const keyPair = await window.crypto.subtle.generateKey(
        {
          name: 'ECDH',
          namedCurve: 'P-256'
        },
        true,
        ['deriveKey', 'deriveBits']
      ) as CryptoKeyPair

      const publicKeyRaw = await window.crypto.subtle.exportKey('raw', keyPair.publicKey)
      const privateKeyRaw = await window.crypto.subtle.exportKey('pkcs8', keyPair.privateKey)

      publicKey = new Uint8Array(publicKeyRaw)
      privateKey = new Uint8Array(privateKeyRaw)
      
      console.log('[Crypto] ECDH P-256 key generation successful')
    }

    console.log('[Crypto] Generated keys - public:', publicKey.length, 'bytes, private:', privateKey.length, 'bytes')

    // Validate we got proper keys
    if (publicKey.length === 0 || privateKey.length === 0) {
      throw new Error(`Invalid key length: public=${publicKey.length}, private=${privateKey.length}`)
    }

    // Store in localStorage as base64
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      publicKey: bytesToBase64(publicKey),
      privateKey: bytesToBase64(privateKey),
      algorithm: publicKey.length === 32 ? 'X25519' : 'ECDH-P256'
    }))

    console.log('[Crypto] Keys stored in localStorage')

    return { publicKey, privateKey }
  } catch (e) {
    console.error('[Crypto] Key generation failed:', e)
    throw new Error('Failed to generate encryption keys: ' + (e as Error).message)
  }
}

// Get stored public key for sharing
export function getPublicKey(): Uint8Array | null {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored)
    return parsed.publicKey ? base64ToBytes(parsed.publicKey) : null
  } catch {
    return null
  }
}

// Get public key as base64 string for API
export function getPublicKeyBase64(): string | null {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored)
    return parsed.publicKey || null
  } catch {
    return null
  }
}

// Derive shared secret using X25519 or ECDH
async function deriveSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Promise<CryptoKey> {
  try {
    // Detect algorithm based on key size
    const isX25519 = privateKey.length === 32 && publicKey.length === 32
    const algorithm = isX25519 ? 'X25519' : 'ECDH'
    
    console.log('[Crypto] Deriving shared secret using', algorithm)
    
    if (isX25519) {
      // X25519 path
      const privateKeyObj = await window.crypto.subtle.importKey(
        'raw',
        privateKey.buffer as ArrayBuffer,
        { name: 'X25519' },
        false,
        ['deriveKey']
      )

      const publicKeyObj = await window.crypto.subtle.importKey(
        'raw',
        publicKey.buffer as ArrayBuffer,
        { name: 'X25519' },
        false,
        []
      )

      return window.crypto.subtle.deriveKey(
        {
          name: 'X25519',
          public: publicKeyObj
        },
        privateKeyObj,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
    } else {
      // ECDH P-256 path
      const privateKeyObj = await window.crypto.subtle.importKey(
        'pkcs8',
        privateKey.buffer as ArrayBuffer,
        {
          name: 'ECDH',
          namedCurve: 'P-256'
        },
        false,
        ['deriveKey']
      )

      const publicKeyObj = await window.crypto.subtle.importKey(
        'raw',
        publicKey.buffer as ArrayBuffer,
        {
          name: 'ECDH',
          namedCurve: 'P-256'
        },
        false,
        []
      )

      return window.crypto.subtle.deriveKey(
        {
          name: 'ECDH',
          public: publicKeyObj
        },
        privateKeyObj,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
    }
  } catch (error) {
    console.error('[Crypto] Key derivation failed:', error)
    throw error
  }
}

// Encrypt a message
export async function encryptMessage(
  message: string,
  recipientPublicKey: Uint8Array
): Promise<EncryptedMessage> {
  console.log('[Crypto] Encrypting message, recipient key length:', recipientPublicKey.length)
  const keys = await getOrCreateKeys()
  console.log('[Crypto] Got keys, deriving shared secret...')
  const sharedKey = await deriveSharedSecret(keys.privateKey, recipientPublicKey)
  console.log('[Crypto] Shared secret derived successfully')

  // Generate random nonce
  const nonce = window.crypto.getRandomValues(new Uint8Array(12))

  // Encrypt
  const encoder = new TextEncoder()
  const encodedMessage = encoder.encode(message)

  const encrypted = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce
    },
    sharedKey,
    encodedMessage
  )

  return {
    content: bytesToBase64(new Uint8Array(encrypted)),
    nonce: bytesToBase64(nonce)
  }
}

// Decrypt a message
export async function decryptMessage(
  encrypted: EncryptedMessage,
  senderPublicKey: Uint8Array
): Promise<string> {
  const keys = await getOrCreateKeys()
  const sharedKey = await deriveSharedSecret(keys.privateKey, senderPublicKey)

  const nonce = base64ToBytes(encrypted.nonce)
  const content = base64ToBytes(encrypted.content)

  try {
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce.buffer as ArrayBuffer
      },
      sharedKey,
      content.buffer as ArrayBuffer
    )

    const decoder = new TextDecoder()
    return decoder.decode(decrypted)
  } catch (e) {
    throw new Error('Failed to decrypt message: ' + (e as Error).message)
  }
}

// Utility functions
export function bytesToBase64(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (x) => String.fromCharCode(x)).join('')
  return btoa(binString)
}

export function base64ToBytes(base64: string): Uint8Array {
  if (!base64 || typeof base64 !== 'string') return new Uint8Array()
  const cleanBase64 = base64.replace(/\s/g, '')
  try {
    const binString = atob(cleanBase64)
    return Uint8Array.from(binString, (m) => m.charCodeAt(0))
  } catch (e) {
    console.error('Invalid base64:', cleanBase64.substring(0, 50))
    return new Uint8Array()
  }
}

// Generate a random invite code
export function generateInviteCode(): string {
  const array = new Uint8Array(16)
  window.crypto.getRandomValues(array)
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('')
}
