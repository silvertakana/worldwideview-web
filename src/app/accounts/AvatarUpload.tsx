'use client'

import { useRef, useState } from 'react'
import { updateAvatar } from './actions'
import { diceBearUrl } from '@/lib/diceBear'
import styles from './AvatarUpload.module.css'

interface AvatarUploadProps {
  /** Fallback seed (email or display name) used for DiceBear when no upload exists. */
  name: string
  /** Currently persisted avatar URL; null means no upload has been made yet. */
  initialAvatarUrl: string | null
}

/** Maximum dimension for resized avatar images in pixels. */
const AVATAR_SIZE = 200

/**
 * Resizes an image file to a square canvas and returns a JPEG data URL.
 *
 * @param file - The image file selected by the user.
 * @param size - Target pixel dimension for both width and height.
 * @returns A promise resolving to a base64 data URL (JPEG quality 0.75).
 */
function resizeToDataUrl(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas context unavailable'))
        return
      }
      // Center-crop to square before scaling down.
      const shorter = Math.min(img.naturalWidth, img.naturalHeight)
      const sx = (img.naturalWidth - shorter) / 2
      const sy = (img.naturalHeight - shorter) / 2
      ctx.drawImage(img, sx, sy, shorter, shorter, 0, 0, size, size)
      resolve(canvas.toDataURL('image/jpeg', 0.75))
    }

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Image failed to load'))
    }

    img.src = objectUrl
  })
}

/**
 * Circular avatar with an inline "Change photo" trigger.
 *
 * Displays a real uploaded URL if present; falls back to DiceBear seeded by
 * `name`. On file selection the image is center-cropped, resized to 200x200,
 * and persisted via the `updateAvatar` server action.
 */
export function AvatarUpload({ name, initialAvatarUrl }: AvatarUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatarUrl)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const displaySrc =
    avatarUrl && (avatarUrl.startsWith('data:') || avatarUrl.startsWith('http'))
      ? avatarUrl
      : diceBearUrl(name)

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setLoading(true)
    setError(null)

    try {
      const dataUrl = await resizeToDataUrl(file, AVATAR_SIZE)
      await updateAvatar(dataUrl)
      setAvatarUrl(dataUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
    } finally {
      setLoading(false)
      // Reset input so re-selecting the same file triggers onChange again.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className={styles.wrapper}>
      <img src={displaySrc} alt="Your avatar" className={styles.uploadImg} />

      <button
        type="button"
        className={styles.changeBtn}
        disabled={loading}
        onClick={() => inputRef.current?.click()}
      >
        {loading ? 'Uploading...' : 'Change photo'}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className={styles.hiddenInput}
        onChange={handleFileChange}
      />

      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
