// TS's lib.dom.d.ts couvre déjà FileSystemDirectoryHandle/FileSystemFileHandle
// mais pas encore showDirectoryPicker() ni les méthodes de permission — ajoutés
// ici manuellement plutôt que d'ajouter une dépendance juste pour ces trois
// déclarations.
export {};

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: "read" | "readwrite";
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface Window {
    showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  }
}
