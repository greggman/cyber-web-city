declare const __DEV__: boolean;

declare module '*.wgsl' {
  const code: string;
  export default code;
}
