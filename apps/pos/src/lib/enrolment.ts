const ENROLMENT_KEY = "kassa.pos.enrolment";

export function isEnrolled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(ENROLMENT_KEY) !== null;
}
