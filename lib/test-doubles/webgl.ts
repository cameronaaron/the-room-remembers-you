/** Records the GPU command contract; does not pretend to execute shader pixels. */
export function fakeWebGl(options: { fail?: string; nth?: number; extension?: boolean; compile?: boolean; link?: boolean; complete?: boolean; log?: string | null; lost?: boolean } = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const live = new Set<object>();
  const counts = new Map<string, number>();
  const canvas = { width: 800, height: 600 };
  const api: Record<string, unknown> = { canvas };
  for (const name of ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','ARRAY_BUFFER','STATIC_DRAW','FLOAT','TEXTURE_2D','RGBA32F','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','NEAREST','LINEAR','TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','FRAMEBUFFER','COLOR_ATTACHMENT0','COLOR_ATTACHMENT1','FRAMEBUFFER_COMPLETE','RGBA','UNSIGNED_BYTE','R8','RED','UNPACK_ALIGNMENT','BLEND','TEXTURE0','TEXTURE1','TEXTURE2','TEXTURE3','TRIANGLES','POINTS','COLOR_BUFFER_BIT','ONE','ZERO','ONE_MINUS_SRC_COLOR']) api[name] = name;
  const record = (name: string, args: unknown[]) => calls.push({ name, args: args.map(value => ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value) });
  for (const kind of ['Shader','Program','Buffer','VertexArray','Texture','Framebuffer']) {
    api[`create${kind}`] = (...args: unknown[]) => {
      const name = `create${kind}`; record(name, args);
      const count = (counts.get(name) ?? 0) + 1; counts.set(name, count);
      if (options.fail === name && count === (options.nth ?? 1)) return null;
      const value = { kind, count }; live.add(value); return value;
    };
    api[`delete${kind}`] = (value: object) => { record(`delete${kind}`, [value]); live.delete(value); };
  }
  for (const name of ['shaderSource','compileShader','attachShader','linkProgram','bindVertexArray','bindBuffer','bufferData','enableVertexAttribArray','vertexAttribPointer','bindTexture','texStorage2D','texParameteri','bindFramebuffer','framebufferTexture2D','drawBuffers','texImage2D','texSubImage2D','pixelStorei','viewport','disable','useProgram','activeTexture','uniform1i','uniform1f','uniform2f','uniform4fv','uniform1fv','drawArrays','clearColor','clear','enable','blendFunc']) api[name] = (...args: unknown[]) => record(name, args);
  api.getExtension = (name: string) => name === 'WEBGL_lose_context' ? { loseContext: () => record('loseContext', []) } : options.extension === false ? null : {};
  // A real WebGL2 context always answers this and `SwarmRenderer` reads it for
  // `alive`; a double that omits it makes the renderer throw where a real one
  // reports a state. `loseContext` deliberately does not flip it: this double
  // hands the same context object to every `getContext`, while in a browser
  // `SwarmRenderer.probe` loses a context of its own that the renderer never
  // uses. Tests that want a lost context say so with `lost: true`.
  api.isContextLost = () => options.lost === true;
  api.getShaderParameter = () => options.compile !== false;
  api.getProgramParameter = () => options.link !== false;
  api.getShaderInfoLog = api.getProgramInfoLog = () => options.log;
  api.getAttribLocation = () => 0;
  api.getUniformLocation = (_: unknown, name: string) => name;
  api.checkFramebufferStatus = () => options.complete === false ? 'INCOMPLETE' : 'FRAMEBUFFER_COMPLETE';
  const gl = api as unknown as WebGL2RenderingContext;
  return { gl, calls, live, canvas: Object.assign(canvas, { getContext: () => gl }) as unknown as HTMLCanvasElement };
}
