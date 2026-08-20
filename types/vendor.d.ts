declare module "@ffmpeg-installer/ffmpeg" {
  interface Installer {
    path: string;
    version: string;
    url: string;
  }
  const value: Installer;
  export default value;
}

declare module "@ffprobe-installer/ffprobe" {
  interface Installer {
    path: string;
    version: string;
    url: string;
  }
  const value: Installer;
  export default value;
}
