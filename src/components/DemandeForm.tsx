import React, { useState } from 'react';
import { 
  FileText, Upload, CheckCircle2, AlertCircle, AlertTriangle, Copy, Check, Download, 
  ArrowRight, ArrowLeft, Shield, Paperclip, X, Eye, Clock, User, RefreshCw
} from 'lucide-react';
import { translations } from '../types.ts';
import { createDemande, generateNumeroSuivi, updateDemande, DemandeModel } from '../services/demandesService.ts';
import { 
  validatePieceJustificative, 
  uploadPieceJustificativeResumable, 
  compressImage, 
  UploadedFileMeta 
} from '../services/storageService.ts';
import { generateReceiptPdf } from '../services/pdfService.ts';

interface DemandeFormProps {
  lang: 'ar' | 'fr';
  initialDocType?: string;
  onGoToTrack?: (numeroSuivi: string) => void;
  onCancel?: () => void;
}

export default function DemandeForm({ lang, initialDocType, onGoToTrack, onCancel }: DemandeFormProps) {
  const t = translations[lang];
  const isRTL = lang === 'ar';

  // Form State
  const [docType, setDocType] = useState<string>(initialDocType || 'extrait_naissance');
  const [numberOfCopies, setNumberOfCopies] = useState<number>(1);
  const [cin, setCin] = useState<string>('');
  const [nomComplet, setNomComplet] = useState<string>('');
  const [dateNaissance, setDateNaissance] = useState<string>('');
  const [lieuNaissance, setLieuNaissance] = useState<string>('');
  const [communeEnregistrement, setCommuneEnregistrement] = useState<string>(
    lang === 'ar' ? 'جماعة أولاد تايمة' : 'Commune d\'Ouled Teima'
  );
  const [anneeEnregistrement, setAnneeEnregistrement] = useState<string>(new Date().getFullYear().toString());
  const [numeroActe, setNumeroActe] = useState<string>('');
  const [telephone, setTelephone] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [adresse, setAdresse] = useState<string>('');

  // Files State
  const [cinRectoFile, setCinRectoFile] = useState<File | null>(null);
  const [cinVersoFile, setCinVersoFile] = useState<File | null>(null);
  const [complementaryFiles, setComplementaryFiles] = useState<File[]>([]);

  // UI / Progress State
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [uploadStepMsg, setUploadStepMsg] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [completedDemande, setCompletedDemande] = useState<DemandeModel | null>(null);
  const [copiedSuccess, setCopiedSuccess] = useState<boolean>(false);

  // File Upload Progress State
  const [uploadProgress, setUploadProgress] = useState<{
    currentFileName: string;
    percent: number;
    currentIndex: number;
    totalCount: number;
  } | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [uploadWarning, setUploadWarning] = useState<string>('');

  // Validate Act number format e.g. "234/78" or "12/2020"
  const validateActNumber = (num: string) => {
    return /^[\d]{1,6}\/[\d]{2,4}$/.test(num.trim());
  };

  const handleFileChange = (
    e: React.ChangeEvent<HTMLInputElement>, 
    target: 'recto' | 'verso' | 'complementaire'
  ) => {
    setErrorMessage('');
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (target === 'recto') {
      const file = files[0];
      const check = validatePieceJustificative(file, lang);
      if (!check.valid) {
        setErrorMessage(check.error || '');
        return;
      }
      setCinRectoFile(file);
    } else if (target === 'verso') {
      const file = files[0];
      const check = validatePieceJustificative(file, lang);
      if (!check.valid) {
        setErrorMessage(check.error || '');
        return;
      }
      setCinVersoFile(file);
    } else {
      // Complementary
      const newFiles: File[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const check = validatePieceJustificative(file, lang);
        if (!check.valid) {
          setErrorMessage(check.error || '');
          return;
        }
        newFiles.push(file);
      }
      setComplementaryFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setUploadWarning('');
    setUploadProgress(null);
    setUploadStatus('idle');

    // Field Validations
    if (!cin.trim() || !nomComplet.trim() || !dateNaissance || !lieuNaissance.trim()) {
      setErrorMessage(
        lang === 'ar' 
          ? 'يرجى ملء جميع الحقول الإلزامية الخاصة بهوية صاحب الطلب.' 
          : 'Veuillez renseigner tous les champs obligatoires du requérant.'
      );
      return;
    }

    if (!numeroActe.trim()) {
      setErrorMessage(
        lang === 'ar'
          ? 'يرجى إدخال رقم رسم الولادة (مثال: 78/234).'
          : 'Veuillez saisir le numéro de l\'acte de naissance (ex: 234/78).'
      );
      return;
    }

    if (!telephone.trim()) {
      setErrorMessage(
        lang === 'ar' ? 'يرجى إدخال رقم هاتف صالح للتواصل.' : 'Veuillez renseigner un numéro de téléphone valide.'
      );
      return;
    }

    if (!adresse.trim()) {
      setErrorMessage(
        lang === 'ar' ? 'يرجى إدخال عنوان الإقامة الحالي.' : 'Veuillez renseigner votre adresse de résidence.'
      );
      return;
    }

    setIsSubmitting(true);
    setUploadStepMsg(
      lang === 'ar' 
        ? 'جاري تسجيل الطلب وتوليد رقم التتبع...' 
        : 'Enregistrement de la demande dans la base de données...'
    );

    const numeroSuivi = generateNumeroSuivi();
    const totalFiles = (cinRectoFile ? 1 : 0) + (cinVersoFile ? 1 : 0) + complementaryFiles.length;

    // 1. ORDRE : Enregistrement D'ABORD dans Firestore (collection "demandes", ID = numeroSuivi)
    // avec les champs texte et statut "Nouvelle", SANS attendre les fichiers.
    // Elle apparaît ainsi immédiatement dans EmployeeDashboard via onSnapshot.
    const initialDemandeData: DemandeModel = {
      id: numeroSuivi,
      numeroSuivi,
      cin: cin.trim().toUpperCase(),
      nomComplet: nomComplet.trim(),
      dateNaissance,
      lieuNaissance: lieuNaissance.trim(),
      communeEnregistrement: communeEnregistrement.trim(),
      anneeEnregistrement: anneeEnregistrement.trim(),
      numeroActe: numeroActe.trim(),
      telephone: telephone.trim(),
      email: email.trim() || undefined,
      adresse: adresse.trim(),
      typeDocument: docType,
      nombreCopies: Number(numberOfCopies) || 1,
      statut: 'Nouvelle',
      piecesStatut: totalFiles > 0 ? 'en_cours' : 'aucune',
      cinRectoUrl: '',
      cinVersoUrl: '',
      piecesJointes: [],
      notesInternes: '',
      notesCitoyen: '',
      dateRetrait: '',
      createdAt: new Date().toISOString(),
    };

    try {
      await createDemande(initialDemandeData);
      
      // 4. Écran de confirmation : affiché dès que le document Firestore est créé
      setCompletedDemande(initialDemandeData);
    } catch (firestoreErr: any) {
      console.error('Erreur enregistrement Firestore initial:', firestoreErr?.code || firestoreErr?.message, firestoreErr);
      setErrorMessage(
        firestoreErr?.message || 
        (lang === 'ar' 
          ? 'تعذر تسجيل الطلب في قاعدة البيانات. يرجى التحقق من الاتصال والمحاولة مجدداً.' 
          : 'Impossible d\'enregistrer la demande dans la base de données. Veuillez réessayer.')
      );
      setIsSubmitting(false);
      setUploadStepMsg('');
      return;
    } finally {
      setIsSubmitting(false);
      setUploadStepMsg('');
    }

    // Si aucune pièce justificative n'est sélectionnée, arrêter ici
    if (totalFiles === 0) {
      setUploadStatus('success');
      return;
    }

    // 2. FICHIERS : ensuite, téléverse les pièces avec uploadBytesResumable, une par une,
    // avec barre de progression (%) pour chaque fichier, puis mets à jour le document (updateDoc)
    setUploadStatus('uploading');
    const uploadedAttachments: UploadedFileMeta[] = [];
    let cinRectoUrl = '';
    let cinVersoUrl = '';
    let fileIndex = 0;

    try {
      // Upload CIN Recto
      if (cinRectoFile) {
        fileIndex++;
        setUploadProgress({
          currentFileName: lang === 'ar' ? 'صورة الوجه الأمامي للبطاقة الوطنية (CIN Recto)' : 'CIN Recto',
          percent: 0,
          currentIndex: fileIndex,
          totalCount: totalFiles,
        });

        // 5. Compresse côté client les images (JPG/PNG) avant envoi (max 1600 px, qualité 0.8)
        const compressedRecto = await compressImage(cinRectoFile);
        const metaRecto = await uploadPieceJustificativeResumable(
          numeroSuivi,
          compressedRecto,
          'cin_recto',
          (pct) => setUploadProgress((prev) => prev ? { ...prev, percent: pct } : null),
          30000 // Timeout strict de 30 secondes
        );
        uploadedAttachments.push(metaRecto);
        cinRectoUrl = metaRecto.url;
      }

      // Upload CIN Verso
      if (cinVersoFile) {
        fileIndex++;
        setUploadProgress({
          currentFileName: lang === 'ar' ? 'صورة الوجه الخلفي للبطاقة الوطنية (CIN Verso)' : 'CIN Verso',
          percent: 0,
          currentIndex: fileIndex,
          totalCount: totalFiles,
        });

        const compressedVerso = await compressImage(cinVersoFile);
        const metaVerso = await uploadPieceJustificativeResumable(
          numeroSuivi,
          compressedVerso,
          'cin_verso',
          (pct) => setUploadProgress((prev) => prev ? { ...prev, percent: pct } : null),
          30000
        );
        uploadedAttachments.push(metaVerso);
        cinVersoUrl = metaVerso.url;
      }

      // Upload Complementary files
      for (let i = 0; i < complementaryFiles.length; i++) {
        const compFile = complementaryFiles[i];
        fileIndex++;
        setUploadProgress({
          currentFileName: compFile.name,
          percent: 0,
          currentIndex: fileIndex,
          totalCount: totalFiles,
        });

        const compressedComp = await compressImage(compFile);
        const metaComp = await uploadPieceJustificativeResumable(
          numeroSuivi,
          compressedComp,
          'complementaire',
          (pct) => setUploadProgress((prev) => prev ? { ...prev, percent: pct } : null),
          30000
        );
        uploadedAttachments.push(metaComp);
      }

      // Mise à jour finale du document dans Firestore avec les URLs et pièces
      try {
        await updateDemande(numeroSuivi, {
          cinRectoUrl,
          cinVersoUrl,
          piecesJointes: uploadedAttachments,
          piecesStatut: 'succes',
        });
      } catch (updateErr: any) {
        console.error('Erreur technique updateDoc pieces:', updateErr?.code || updateErr?.message, updateErr);
      }

      // Mettre à jour l'objet local dans l'état
      setCompletedDemande((prev) =>
        prev
          ? {
              ...prev,
              cinRectoUrl,
              cinVersoUrl,
              piecesJointes: uploadedAttachments,
              piecesStatut: 'succes',
            }
          : null
      );
      setUploadStatus('success');
      setUploadProgress(null);

    } catch (uploadErr: any) {
      // 3. TIMEOUT / ERREURS : si un upload dépasse 30 secondes ou échoue (Storage indisponible, règles, réseau)
      console.error('Erreur technique exacte Storage (error.code):', uploadErr?.code || uploadErr?.message || 'storage/unknown', uploadErr);

      // Marquer dans le document piecesStatut: "echec"
      try {
        await updateDemande(numeroSuivi, { piecesStatut: 'echec' });
      } catch (markErr: any) {
        console.error('Erreur technique updateDoc piecesStatut: echec:', markErr?.code || markErr?.message, markErr);
      }

      setUploadStatus('error');
      setUploadProgress(null);
      setUploadWarning(
        lang === 'ar'
          ? 'تم تسجيل الطلب، لكن تعذر رفع الوثائق المرفقة. يرجى الحضور إلى شباك الحالة المدنية مصحوباً بالوثائق الأصلية.'
          : 'Demande enregistrée, mais l\'envoi des pièces a échoué. Présentez-vous avec vos originaux au guichet.'
      );
    }
  };

  const handleCopyCode = () => {
    if (!completedDemande) return;
    navigator.clipboard.writeText(completedDemande.numeroSuivi);
    setCopiedSuccess(true);
    setTimeout(() => setCopiedSuccess(false), 2500);
  };

  // SUCCESS CONFIRMATION VIEW
  if (completedDemande) {
    return (
      <div className="max-w-3xl mx-auto my-10 p-6 sm:p-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-xl text-center">
        {/* Moroccan Success Badge */}
        <div className="mx-auto w-20 h-20 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border-2 border-emerald-500 flex items-center justify-center text-emerald-600 dark:text-emerald-400 mb-6 animate-bounce">
          <CheckCircle2 className="w-12 h-12" />
        </div>

        <h2 className="text-2xl sm:text-3xl font-sans font-bold text-slate-900 dark:text-white tracking-tight">
          {lang === 'ar' ? 'تم تسجيل طلبكم بنجاح تام !' : 'Demande enregistrée avec succès !'}
        </h2>
        
        <p className="mt-3 text-slate-600 dark:text-slate-300 text-sm max-w-lg mx-auto leading-relaxed">
          {lang === 'ar' 
            ? 'تم إرسال طلبكم رسمياً إلى مصلحة الحالة المدنية بجماعة أولاد تايمة. احتفظوا برقم التتبع الخاص بكم للاستعلام عن مسار المعالجة أو سحب الوثيقة.'
            : 'Votre demande a été officiellement transmise au service de l\'état civil de la Commune d\'Ouled Teima. Conservez précieusement votre numéro de suivi.'}
        </p>

        {/* Highlighted Tracking Number Box */}
        <div className="mt-8 p-6 bg-blue-50/80 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/60 rounded-2xl max-w-md mx-auto">
          <p className="text-xs uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider mb-2">
            {lang === 'ar' ? 'رقم التتبع الخاص بطلبكم' : 'Votre Numéro de Suivi Unique'}
          </p>
          <div className="flex items-center justify-center gap-3">
            <span className="font-mono text-2xl sm:text-3xl font-extrabold text-[#005BAC] dark:text-blue-400 tracking-wider">
              {completedDemande.numeroSuivi}
            </span>
            <button
              onClick={handleCopyCode}
              className="p-2 text-slate-500 hover:text-[#005BAC] bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition-all"
              title={lang === 'ar' ? 'نسخ الرمز' : 'Copier'}
            >
              {copiedSuccess ? <Check className="w-5 h-5 text-emerald-600" /> : <Copy className="w-5 h-5" />}
            </button>
          </div>
          {copiedSuccess && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2 font-medium">
              {lang === 'ar' ? 'تم نسخ رقم التتبع بنجاح' : 'Numéro copié dans le presse-papiers'}
            </p>
          )}
        </div>

        {/* File Upload Progress Widget during active upload */}
        {uploadStatus === 'uploading' && uploadProgress && (
          <div className="mt-6 p-4 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-2xl max-w-md mx-auto text-start">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1.5">
              <span className="flex items-center gap-2 truncate">
                <RefreshCw className="w-3.5 h-3.5 text-[#005BAC] animate-spin shrink-0" />
                <span className="truncate">{uploadProgress.currentFileName}</span>
              </span>
              <span className="shrink-0 font-mono text-[#005BAC] dark:text-blue-400 font-bold">
                {uploadProgress.percent}% ({uploadProgress.currentIndex}/{uploadProgress.totalCount})
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 h-2.5 rounded-full overflow-hidden">
              <div 
                className="bg-[#005BAC] h-full transition-all duration-300 rounded-full"
                style={{ width: `${uploadProgress.percent}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5 text-center">
              {lang === 'ar' ? 'جاري رفع الوثائق المرفقة إلى السيرفر...' : 'Téléversement des pièces justificatives...'}
            </p>
          </div>
        )}

        {/* File Upload Warning / Error Widget */}
        {(uploadStatus === 'error' || uploadWarning) && (
          <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-2xl max-w-lg mx-auto text-amber-800 dark:text-amber-200 flex items-start gap-3 text-start">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs sm:text-sm font-medium leading-relaxed">
              <p className="font-bold mb-0.5 text-amber-900 dark:text-amber-100">
                {lang === 'ar' ? 'تنبيه بخصوص الوثائق المرفقة :' : 'Information concernant vos pièces :'}
              </p>
              <p>{uploadWarning}</p>
            </div>
          </div>
        )}

        {/* File Upload Success Badge */}
        {uploadStatus === 'success' && (cinRectoFile || cinVersoFile || complementaryFiles.length > 0) && (
          <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            <Check className="w-4 h-4 text-emerald-600" />
            <span>
              {lang === 'ar' 
                ? 'تم رفع جميع الوثائق المرفقة بنجاح' 
                : 'Toutes les pièces justificatives ont été téléversées avec succès.'}
            </span>
          </div>
        )}

        {/* Download Receipt and Track Actions */}
        <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center items-center">
          <button
            onClick={() => generateReceiptPdf(completedDemande, lang)}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-6 py-3.5 bg-[#198754] hover:bg-[#157145] text-white font-bold rounded-xl shadow-md hover:shadow-lg transition-all text-sm"
          >
            <Download className="w-5 h-5" />
            <span>{lang === 'ar' ? 'تحميل وصل الإيداع الرسمي (PDF)' : 'Télécharger le Récépissé Officiel (PDF)'}</span>
          </button>

          {onGoToTrack && (
            <button
              onClick={() => onGoToTrack(completedDemande.numeroSuivi)}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-6 py-3.5 bg-[#005BAC] hover:bg-[#004b91] text-white font-bold rounded-xl shadow-md hover:shadow-lg transition-all text-sm"
            >
              <Eye className="w-5 h-5" />
              <span>{lang === 'ar' ? 'تتبع حالة الطلب الآن' : 'Suivre ma demande'}</span>
            </button>
          )}
        </div>

        {/* Instructions */}
        <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 max-w-lg mx-auto text-start">
          <p className="font-bold text-slate-700 dark:text-slate-300 mb-1">
            {lang === 'ar' ? 'تعليمات الاستلام :' : 'Consignes de retrait :'}
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>{lang === 'ar' ? 'سيتم إشعاركم فور جاهزية وثيقتكم من خلال خانة التتبع.' : 'Le statut passera à "Prêt pour retrait" après instruction de votre dossier.'}</li>
            <li>{lang === 'ar' ? 'يجب الإدلاء بالبطاقة الوطنية للتعريف الأصلية ووصل الإيداع عند سحب الوثيقة.' : 'Présentez votre CIN originale et ce récépissé au guichet communal.'}</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto my-8 px-4 sm:px-6">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-xl overflow-hidden">
        
        {/* Header Header */}
        <div className="bg-gradient-to-r from-[#005BAC] via-[#004b91] to-[#198754] text-white p-6 sm:p-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2.5 bg-white/10 rounded-2xl backdrop-blur-sm">
              <FileText className="w-6 h-6 text-emerald-300" />
            </div>
            <div>
              <h2 className="text-xl sm:text-2xl font-sans font-bold tracking-tight">
                {lang === 'ar' ? 'طلب وثيقة الحالة المدنية عبر الإنترنت' : 'Demande d\'acte d\'état civil en ligne'}
              </h2>
              <p className="text-xs sm:text-sm text-blue-100/90 mt-0.5">
                {lang === 'ar' ? 'مصلحة الحالة المدنية - جماعة أولاد تايمة (خدمة مجانية ومباشرة بدون إنشاء حساب)' : 'Service de l\'État Civil - Commune d\'Ouled Teima (Sans création de compte préalable)'}
              </p>
            </div>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 sm:p-8 space-y-8">
          
          {/* Error Message */}
          {errorMessage && (
            <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-400 text-xs sm:text-sm flex gap-3 items-start animate-shake">
              <AlertCircle className="w-5 h-5 shrink-0 text-red-600 dark:text-red-400 mt-0.5" />
              <div className="font-semibold leading-relaxed">{errorMessage}</div>
            </div>
          )}

          {/* Section 1: Document Details */}
          <div>
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
              <span className="w-6 h-6 rounded-full bg-[#005BAC] text-white text-xs font-bold flex items-center justify-center">1</span>
              <h3 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base">
                {lang === 'ar' ? 'نوع الوثيقة المطلوبة وعدد النسخ' : 'Document demandé et nombre d\'exemplaires'}
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formDocType} <span className="text-red-500">*</span>
                </label>
                <select
                  value={docType}
                  onChange={(e) => setDocType(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-medium outline-none focus:border-[#005BAC]"
                >
                  <option value="extrait_naissance">{t.srvExtrait}</option>
                  <option value="copie_integrale">{t.srvCopie}</option>
                  <option value="acte_deces">{t.srvDeces}</option>
                  <option value="declaration_naissance">{t.srvNaissance}</option>
                  <option value="rectification">{t.srvRectif}</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formCopies} (1 - 10) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={numberOfCopies}
                  onChange={(e) => setNumberOfCopies(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-semibold outline-none focus:border-[#005BAC]"
                  required
                />
              </div>
            </div>
          </div>

          {/* Section 2: Act & Register Information */}
          <div>
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
              <span className="w-6 h-6 rounded-full bg-[#005BAC] text-white text-xs font-bold flex items-center justify-center">2</span>
              <h3 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base">
                {lang === 'ar' ? 'معلومات رسم الحالة المدنية بالسجل' : 'Informations du registre de l\'état civil'}
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {lang === 'ar' ? 'رقم رسم الولادة (مثال: 78/234)' : 'N° de l\'acte (ex: 234/78)'} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="234/78"
                  value={numeroActe}
                  onChange={(e) => setNumeroActe(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-mono font-bold outline-none focus:border-[#005BAC]"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formActYear} <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1920"
                  max={new Date().getFullYear()}
                  value={anneeEnregistrement}
                  onChange={(e) => setAnneeEnregistrement(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-semibold outline-none focus:border-[#005BAC]"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formActOffice} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={communeEnregistrement}
                  onChange={(e) => setCommuneEnregistrement(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-medium outline-none focus:border-[#005BAC]"
                  required
                />
              </div>
            </div>
          </div>

          {/* Section 3: Citizen Personal Data */}
          <div>
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
              <span className="w-6 h-6 rounded-full bg-[#005BAC] text-white text-xs font-bold flex items-center justify-center">3</span>
              <h3 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base">
                {lang === 'ar' ? 'البيانات الشخصية لصاحب الطلب' : 'Identité et coordonnées du requérant'}
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formFullName} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder={lang === 'ar' ? 'الاسم العائلي والشخصي' : 'Nom et prénom'}
                  value={nomComplet}
                  onChange={(e) => setNomComplet(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-semibold outline-none focus:border-[#005BAC]"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formCin} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="Ex: JH123456"
                  value={cin}
                  onChange={(e) => setCin(e.target.value.toUpperCase())}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-mono font-bold outline-none focus:border-[#005BAC]"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formDob} <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={dateNaissance}
                  onChange={(e) => setDateNaissance(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-semibold outline-none focus:border-[#005BAC]"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formPob} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder={lang === 'ar' ? 'مكان الازدياد (أولاد تايمة مثلاً)' : 'Lieu de naissance'}
                  value={lieuNaissance}
                  onChange={(e) => setLieuNaissance(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-medium outline-none focus:border-[#005BAC]"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formPhone} <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  placeholder="06 XX XX XX XX"
                  value={telephone}
                  onChange={(e) => setTelephone(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-medium outline-none focus:border-[#005BAC]"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formEmail} ({lang === 'ar' ? 'اختياري' : 'Facultatif'})
                </label>
                <input
                  type="email"
                  placeholder="citoyen@domaine.ma"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-medium outline-none focus:border-[#005BAC]"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.formAddress} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder={lang === 'ar' ? 'العنوان الحالي بأولاد تايمة أو خارجها' : 'Adresse complète de résidence'}
                  value={adresse}
                  onChange={(e) => setAdresse(e.target.value)}
                  className="w-full py-2.5 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white text-xs sm:text-sm font-medium outline-none focus:border-[#005BAC]"
                  required
                />
              </div>
            </div>
          </div>

          {/* Section 4: Attachments & Justificatifs */}
          <div>
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
              <span className="w-6 h-6 rounded-full bg-[#005BAC] text-white text-xs font-bold flex items-center justify-center">4</span>
              <h3 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base">
                {lang === 'ar' ? 'الوثائق والشهادات الداعمة (الحد الأقصى: 5 ميغابايت لكل ملف - PDF, JPG, PNG)' : 'Pièces justificatives (Max 5 Mo / fichier - PDF, JPG, PNG)'}
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              
              {/* CIN Recto */}
              <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-4 bg-slate-50/50 dark:bg-slate-950/40 text-center hover:bg-slate-50 dark:hover:bg-slate-950 transition-all">
                <div className="flex flex-col items-center">
                  <Upload className="w-7 h-7 text-[#005BAC] mb-2" />
                  <span className="text-xs font-bold text-slate-800 dark:text-white">
                    {t.formCinFront}
                  </span>
                  <p className="text-[11px] text-slate-500 mt-1">
                    {cinRectoFile ? cinRectoFile.name : (lang === 'ar' ? 'انقر لاختيار الملف (5 ميغابايت كحد أقصى)' : 'Cliquer pour choisir (Max 5 Mo)')}
                  </p>
                  <label className="mt-3 cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:border-[#005BAC] transition-all">
                    <span>{cinRectoFile ? (lang === 'ar' ? 'تغيير الملف' : 'Changer') : (lang === 'ar' ? 'اختيار ملف' : 'Sélectionner')}</span>
                    <input
                      type="file"
                      accept=".pdf,image/png,image/jpeg,image/jpg"
                      onChange={(e) => handleFileChange(e, 'recto')}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              {/* CIN Verso */}
              <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-4 bg-slate-50/50 dark:bg-slate-950/40 text-center hover:bg-slate-50 dark:hover:bg-slate-950 transition-all">
                <div className="flex flex-col items-center">
                  <Upload className="w-7 h-7 text-[#005BAC] mb-2" />
                  <span className="text-xs font-bold text-slate-800 dark:text-white">
                    {t.formCinBack}
                  </span>
                  <p className="text-[11px] text-slate-500 mt-1">
                    {cinVersoFile ? cinVersoFile.name : (lang === 'ar' ? 'انقر لاختيار الملف (5 ميغابايت كحد أقصى)' : 'Cliquer pour choisir (Max 5 Mo)')}
                  </p>
                  <label className="mt-3 cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:border-[#005BAC] transition-all">
                    <span>{cinVersoFile ? (lang === 'ar' ? 'تغيير الملف' : 'Changer') : (lang === 'ar' ? 'اختيار ملف' : 'Sélectionner')}</span>
                    <input
                      type="file"
                      accept=".pdf,image/png,image/jpeg,image/jpg"
                      onChange={(e) => handleFileChange(e, 'verso')}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              {/* Complementary Documents */}
              <div className="sm:col-span-2 border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-4 bg-slate-50/50 dark:bg-slate-950/40">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                  <div>
                    <span className="text-xs font-bold text-slate-800 dark:text-white block">
                      {lang === 'ar' ? 'وثائق إضافية اختيارية (دفتر العائلة، عقد قديم، إلخ)' : 'Documents complémentaires facultatifs (Livret de famille, etc.)'}
                    </span>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {lang === 'ar' ? 'يمكنكم إرفاق وثائق مساعدة بصيغة PDF أو JPG أو PNG' : 'Formats autorisés : PDF, JPG, PNG (Max 5 Mo par document)'}
                    </p>
                  </div>
                  <label className="cursor-pointer shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:border-[#005BAC] transition-all">
                    <Paperclip className="w-3.5 h-3.5" />
                    <span>{lang === 'ar' ? 'إضافة وثيقة' : 'Ajouter un fichier'}</span>
                    <input
                      type="file"
                      multiple
                      accept=".pdf,image/png,image/jpeg,image/jpg"
                      onChange={(e) => handleFileChange(e, 'complementaire')}
                      className="hidden"
                    />
                  </label>
                </div>

                {complementaryFiles.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {complementaryFiles.map((f, idx) => (
                      <div key={idx} className="flex items-center justify-between py-1 px-2 rounded-lg bg-white dark:bg-slate-800 text-xs border border-slate-200 dark:border-slate-700">
                        <span className="truncate max-w-xs text-slate-700 dark:text-slate-300">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => setComplementaryFiles((prev) => prev.filter((_, i) => i !== idx))}
                          className="text-red-500 hover:text-red-700 p-1"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </div>

          {/* Submit Action */}
          <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Shield className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{lang === 'ar' ? 'معالجة آمنة مشفرة ومطابقة للقوانين المغربية' : 'Traitement sécurisé et conforme aux lois marocaines'}</span>
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto">
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={isSubmitting}
                  className="w-full sm:w-auto px-5 py-3 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                >
                  {lang === 'ar' ? 'إلغاء' : 'Annuler'}
                </button>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl bg-[#005BAC] hover:bg-[#004b91] text-white font-bold text-sm shadow-md hover:shadow-lg transition-all disabled:opacity-50"
              >
                <span>
                  {isSubmitting
                    ? uploadStepMsg || (lang === 'ar' ? 'جاري الإرسال...' : 'Envoi en cours...')
                    : (lang === 'ar' ? 'إرسال الطلب الآن' : 'Soumettre la demande')}
                </span>
                {!isSubmitting && (isRTL ? <ArrowLeft className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />)}
              </button>
            </div>
          </div>

        </form>
      </div>
    </div>
  );
}
