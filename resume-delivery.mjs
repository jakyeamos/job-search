#!/usr/bin/env node

/**
 * Resume delivery helpers.
 *
 * Canonical, audited artifacts remain in the repository. This module creates
 * the candidate-facing delivery copy in the configured local CV directory.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';

export const DEFAULT_RESUME_DELIVERY_DIR = join(homedir(), 'Desktop', 'CVs');

/** @param {string} value */
function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert a name or company into readable, filesystem-safe title-case tokens.
 * Existing internal capitals and short acronyms are preserved (FlexAI, AI).
 * @param {string} value
 */
export function normalizeResumeToken(value) {
  const tokens = normalizeText(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.map((token) => {
    if (/^[A-Z0-9]{2,}$/.test(token)) return token;
    return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
  }).join('-');
}

/** @param {string} root */
export function loadResumeProfile(root) {
  const profilePath = join(root, 'config', 'profile.yml');
  try {
    return loadYaml(readFileSync(profilePath, 'utf8')) || {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

/** @param {Record<string, unknown>} profile */
export function resumeDeliveryDirectory(profile = {}) {
  const configured = normalizeText(String(profile?.cv?.pdf_output_dir || ''));
  const expanded = configured.startsWith('~/')
    ? join(homedir(), configured.slice(2))
    : configured || DEFAULT_RESUME_DELIVERY_DIR;
  return resolve(expanded);
}

/**
 * @param {string} sourcePath
 * @param {Record<string, unknown>} [profile]
 * @param {{ outputDir?: string }} [options]
 */
export function resumeDeliveryPath(sourcePath, profile = {}, options = {}) {
  const outputDir = options.outputDir ? resolve(options.outputDir) : resumeDeliveryDirectory(profile);
  return join(outputDir, basename(sourcePath));
}

/**
 * Copy a verified resume PDF to the candidate-facing delivery directory.
 * @param {string} sourcePath
 * @param {Record<string, unknown>} [profile]
 * @param {{ outputDir?: string }} [options]
 */
export function copyResumePdfToDelivery(sourcePath, profile = {}, options = {}) {
  const source = resolve(sourcePath);
  if (!existsSync(source)) throw new Error(`Cannot deliver missing resume PDF: ${source}`);
  if (basename(source).toLowerCase().endsWith('.pdf') === false) {
    throw new Error(`Cannot deliver a non-PDF resume artifact: ${source}`);
  }
  if (!/-Resume-/i.test(basename(source))) {
    throw new Error(`Per-job resume delivery is retired; expected a canonical lane PDF: ${source}`);
  }
  const target = resumeDeliveryPath(source, profile, options);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return target;
}
