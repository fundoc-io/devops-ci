export type ToolchainType = 'node' | 'java';
export type PackageManager = 'npm' | 'pnpm' | 'yarn';
export type JavaBuildTool = 'maven' | 'gradle';

export interface NodeToolchain {
  type: 'node';
  node: string;
  pm: PackageManager;
  pmver: string;
}

export interface JavaToolchain {
  type: 'java';
  jdk: string;
  buildTool: JavaBuildTool;
  maven?: string;
  gradle?: string;
  skipTests?: boolean;
}

export type Toolchain = NodeToolchain | JavaToolchain;

export interface ToolHome {
  JAVA_HOME?: string;
  MAVEN_HOME?: string;
  GRADLE_HOME?: string;
  minJava?: string;
  probeJavaHome?: string;
  probeJavaSource?: string;
}

export interface PlatformIndex {
  nodeImages: Record<string, string>;
  java: {
    jdks: Record<string, ToolHome>;
    maven: Record<string, ToolHome>;
    gradle: Record<string, ToolHome>;
  };
}

export type DiagnosticLevel = 'error' | 'warning';

export interface Diagnostic {
  level: DiagnosticLevel;
  message: string;
}
