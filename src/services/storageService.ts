import { ref, uploadBytesResumable, getDownloadURL, UploadTask } from 'firebase/storage';
import { storage } from '../firebase.ts';

export interface UploadedFileMeta {
  name: string;
  url: string;
  size: number;
  type: string;
  category?: string;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/pdf',
];

export function validatePieceJustificative(file: File, lang: 'ar' | 'fr' = 'ar'): { valid: boolean; error?: string } {
  if (!file) {
    return {
      valid: false,
      error: lang === 'ar' ? 'الرجاء اختيار ملف صالح.' : 'Veuillez sélectionner un fichier valide.',
    };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error:
        lang === 'ar'
          ? `حجم الملف (${(file.size / (1024 * 1024)).toFixed(1)} ميغابايت) يتجاوز الحد الأقصى المسموح به (5 ميغابايت).`
          : `La taille du fichier (${(file.size / (1024 * 1024)).toFixed(1)} Mo) dépasse la limite maximale de 5 Mo.`,
    };
  }

  if (!ALLOWED_TYPES.includes(file.type.toLowerCase())) {
    return {
      valid: false,
      error:
        lang === 'ar'
          ? 'صيغة الملف غير مقبولة. الصيغ المسموح بها هي: PDF، JPG، PNG فقط.'
          : 'Format de fichier non supporté. Seuls les formats PDF, JPG et PNG sont acceptés.',
    };
  }

  return { valid: true };
}

/**
 * Compresse côté client les images (JPG/PNG) avant envoi (max 1600 px de large, qualité 0.8)
 * pour accélérer l'envoi, en gardant les PDF tels quels.
 */
export async function compressImage(file: File, maxWidth = 1600, quality = 0.8): Promise<File> {
  // Garder les PDF tels quels et ignorer tout ce qui n'est pas une image
  if (file.type === 'application/pdf' || !file.type.startsWith('image/')) {
    return file;
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        // Redimensionner proportionnellement si plus large que maxWidth
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(file); // Repli sur le fichier original
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(file);
              return;
            }
            const compressedFile = new File([blob], file.name, {
              type: mimeType,
              lastModified: Date.now(),
            });
            resolve(compressedFile);
          },
          mimeType,
          quality
        );
      };
      img.onerror = () => resolve(file); // Repli en cas d'erreur de décodage
      img.src = e.target?.result as string;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

/**
 * Téléverse une pièce avec uploadBytesResumable, suivi de progression (%)
 * et timeout strict de 30 secondes pour éviter tout chargement infini.
 */
export function uploadPieceJustificativeResumable(
  numeroSuivi: string,
  file: File,
  category: 'cin_recto' | 'cin_verso' | 'complementaire',
  onProgress?: (percent: number) => void,
  timeoutMs: number = 30000
): Promise<UploadedFileMeta> {
  return new Promise((resolve, reject) => {
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `demandes/${numeroSuivi}/${category}_${Date.now()}_${sanitizedName}`;
    const fileRef = ref(storage, path);

    const metadata = {
      contentType: file.type,
      customMetadata: {
        category,
        numeroSuivi,
        originalName: file.name,
      },
    };

    const uploadTask: UploadTask = uploadBytesResumable(fileRef, file, metadata);
    let isSettled = false;

    // Timeout de 30 secondes
    const timeoutTimer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        try {
          uploadTask.cancel();
        } catch (_) {
          // ignore
        }
        const err: any = new Error(`Délai d'envoi dépassé (${Math.round(timeoutMs / 1000)}s)`);
        err.code = 'storage/timeout';
        console.error('Erreur technique upload Storage (timeout 30s):', err.code, err);
        reject(err);
      }
    }, timeoutMs);

    uploadTask.on(
      'state_changed',
      (snapshot) => {
        if (snapshot.totalBytes > 0 && onProgress) {
          const percent = Math.min(
            100,
            Math.max(0, Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100))
          );
          onProgress(percent);
        }
      },
      (error: any) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          console.error('Erreur technique upload Storage (error.code):', error?.code || 'storage/error', error);
          reject(error);
        }
      },
      async () => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutTimer);
          try {
            const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
            if (onProgress) onProgress(100);
            resolve({
              name: file.name,
              url: downloadUrl,
              size: file.size,
              type: file.type,
              category,
            });
          } catch (urlErr: any) {
            console.error('Erreur technique getDownloadURL (error.code):', urlErr?.code || 'storage/url-error', urlErr);
            reject(urlErr);
          }
        }
      }
    );
  });
}

/**
 * Rétrocompatibilité : upload standard simple
 */
export async function uploadPieceJustificative(
  numeroSuivi: string,
  file: File,
  category: 'cin_recto' | 'cin_verso' | 'complementaire'
): Promise<UploadedFileMeta> {
  const compressed = await compressImage(file);
  return uploadPieceJustificativeResumable(numeroSuivi, compressed, category);
}
