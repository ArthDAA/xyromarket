-- Réduit la durée d'essai par défaut de 7 à 3 jours (décision produit,
-- 2026-09-17) — met à jour la valeur déjà seedée par 001 ; un admin qui
-- l'aurait explicitement changée depuis perdrait sa personnalisation, mais
-- personne ne l'a encore fait à ce stade du projet.
UPDATE settings SET value = '3' WHERE key = 'trial_duration_days';

-- Traçabilité idempotente pour deux nouvelles notifications bot ponctuelles
-- (A34) — même pattern que `announced_at` (A5) : `invite_sent_at` évite de
-- renvoyer l'invitation vers la guilde cible à chaque tick du job de retry
-- tant que le destinataire n'a pas rejoint ; `trial_reminder_sent_at` évite
-- de reposter le rappel de fin d'essai plus d'une fois.
ALTER TABLE transactions ADD COLUMN invite_sent_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN trial_reminder_sent_at TIMESTAMPTZ;
