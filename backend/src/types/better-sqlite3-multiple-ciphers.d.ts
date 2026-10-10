// The encrypting fork has the same API as better-sqlite3 (its own typings are not reachable
// through its package "exports"), so it borrows those types.
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export = Database;
}
