import { apiRequest } from "./api";

export type PersonalProfile = {
  displayName: string;
  countryCode: string;
  contact: string;
  organization: string;
  jobTitle: string;
  professionalTitle: string;
  bio: string;
  version: number;
  updatedAt: string | null;
};

type ProfileResponse = {
  profile: PersonalProfile;
};

const editableProfileFields = ["displayName", "countryCode", "contact", "organization", "jobTitle", "professionalTitle", "bio"] as const;

export function mergePersonalProfileEdits(draft: PersonalProfile, original: PersonalProfile, latest: PersonalProfile) {
  const merged = { ...latest };
  for (const field of editableProfileFields) {
    if (draft[field] !== original[field]) merged[field] = draft[field];
  }
  return sanitizeProfile(merged);
}

export function readPersonalProfileDraft(storage: Pick<Storage, "getItem">, key: string, profile: PersonalProfile) {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 8_000) return profile;
    const edits: unknown = JSON.parse(raw);
    if (!edits || typeof edits !== "object" || Array.isArray(edits)) return profile;
    const restored = { ...profile };
    for (const field of editableProfileFields) {
      const value = (edits as Record<string, unknown>)[field];
      if (typeof value === "string") restored[field] = value;
    }
    return sanitizeProfile(restored);
  } catch {
    return profile;
  }
}

export function writePersonalProfileDraft(storage: Pick<Storage, "setItem" | "removeItem">, key: string, draft: PersonalProfile, original: PersonalProfile) {
  const edits: Record<string, string> = {};
  for (const field of editableProfileFields) {
    if (draft[field] !== original[field]) edits[field] = draft[field];
  }
  try {
    if (Object.keys(edits).length) storage.setItem(key, JSON.stringify(edits));
    else storage.removeItem(key);
  } catch {
    // Editing and saving remain available when browser storage is disabled.
  }
}

function sanitizeProfile(profile: PersonalProfile): PersonalProfile {
  return {
    displayName: profile.displayName.slice(0, 80),
    countryCode: /^(?:[A-Z]{2})?$/u.test(profile.countryCode) ? profile.countryCode : "",
    contact: profile.contact.slice(0, 80),
    organization: profile.organization.slice(0, 120),
    jobTitle: profile.jobTitle.slice(0, 80),
    professionalTitle: profile.professionalTitle.slice(0, 100),
    bio: profile.bio.slice(0, 500),
    version: Number.isSafeInteger(profile.version) && profile.version >= 0 ? profile.version : 0,
    updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : null,
  };
}

export async function loadPersonalProfile() {
  const response = await apiRequest<ProfileResponse>("/me/profile");
  return sanitizeProfile(response.profile);
}

export async function savePersonalProfile(profile: PersonalProfile) {
  const value = sanitizeProfile({
    ...profile,
    displayName: profile.displayName.trim(),
    contact: profile.contact.trim(),
    organization: profile.organization.trim(),
    jobTitle: profile.jobTitle.trim(),
    professionalTitle: profile.professionalTitle.trim(),
    bio: profile.bio.trim(),
  });
  const response = await apiRequest<ProfileResponse>("/me/profile", {
    method: "PUT",
    body: JSON.stringify({
      displayName: value.displayName,
      countryCode: value.countryCode,
      contact: value.contact,
      organization: value.organization,
      jobTitle: value.jobTitle,
      professionalTitle: value.professionalTitle,
      bio: value.bio,
      version: value.version,
    }),
  });
  return sanitizeProfile(response.profile);
}
