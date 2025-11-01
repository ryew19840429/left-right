/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:organize-imports
// tslint:disable:ban-malformed-import-paths
// tslint:disable:no-new-decorators

import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {Analyser} from './analyser';

import * as THREE from 'three';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {FXAAShader} from 'three/addons/shaders/FXAAShader.js';
import {fs as backdropFS, vs as backdropVS} from './backdrop-shader';
import {vs as sphereVS} from './sphere-shader';

/**
 * 3D live audio visual.
 */
@customElement('gdm-live-audio-visuals-3d')
export class GdmLiveAudioVisuals3D extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private camera!: THREE.PerspectiveCamera;
  private backdrop!: THREE.Mesh;
  private composer!: EffectComposer;
  private sphere!: THREE.Mesh;
  private prevTime = 0;
  private rotation = new THREE.Vector3(0, 0, 0);

  private morphTargetIndex = -1; // 0 for left, 1 for right
  private morphProgress = 0;
  private isMorphingIn = false;

  @property({type: String}) direction: 'left' | 'right' | null = null;

  private _outputNode!: AudioNode;

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    this.outputAnalyser = new Analyser(this._outputNode);
  }

  get outputNode() {
    return this._outputNode;
  }

  private _inputNode!: AudioNode;

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    this.inputAnalyser = new Analyser(this._inputNode);
  }

  get inputNode() {
    return this._inputNode;
  }

  private canvas!: HTMLCanvasElement;

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
      image-rendering: pixelated;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
  }

  updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('direction')) {
      if (this.direction === 'left') {
        this.morphTargetIndex = 0;
        this.isMorphingIn = true;
      } else if (this.direction === 'right') {
        this.morphTargetIndex = 1;
        this.isMorphingIn = true;
      } else if (this.direction === null) {
        this.isMorphingIn = false;
      }
    }
  }

  private init() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x100c14);

    const backdrop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(10, 5),
      new THREE.RawShaderMaterial({
        uniforms: {
          resolution: {value: new THREE.Vector2(1, 1)},
          rand: {value: 0},
        },
        vertexShader: backdropVS,
        fragmentShader: backdropFS,
        glslVersion: THREE.GLSL3,
      }),
    );
    backdrop.material.side = THREE.BackSide;
    scene.add(backdrop);
    this.backdrop = backdrop;

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    camera.position.set(2, -2, 5);
    this.camera = camera;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !true,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio / 1);

    const subdivisions = 20;
    const radius = 1.5;

    // Create a box to get original vertex positions for arrow morph
    const boxGeometry = new THREE.BoxGeometry(
      radius * 2,
      radius * 2,
      radius * 2,
      subdivisions,
      subdivisions,
      subdivisions,
    );
    const originalPositions = boxGeometry.attributes.position;
    const vertexCount = originalPositions.count;

    // Create the main geometry, which will be a sphere
    const geometry = new THREE.BufferGeometry();

    // Spherify the box positions to create the sphere base shape
    const spherePositions = new Float32Array(vertexCount * 3);
    const sphereNormals = new Float32Array(vertexCount * 3);
    const sphereUVs = new Float32Array(vertexCount * 2);

    for (let i = 0; i < vertexCount; i++) {
      const i2 = i * 2;
      const i3 = i * 3;

      const p = new THREE.Vector3()
        .fromBufferAttribute(originalPositions, i)
        .normalize();

      spherePositions[i3] = p.x * radius;
      spherePositions[i3 + 1] = p.y * radius;
      spherePositions[i3 + 2] = p.z * radius;

      sphereNormals[i3] = p.x;
      sphereNormals[i3 + 1] = p.y;
      sphereNormals[i3 + 2] = p.z;

      sphereUVs[i2] = 0.5 + Math.atan2(p.z, p.x) / (2 * Math.PI);
      sphereUVs[i2 + 1] = 0.5 - Math.asin(p.y) / Math.PI;
    }

    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(spherePositions, 3),
    );
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(sphereNormals, 3),
    );
    geometry.setAttribute('uv', new THREE.BufferAttribute(sphereUVs, 2));

    // Create arrow morph targets from original box positions
    const leftArrowPositions = new Float32Array(vertexCount * 3);
    const rightArrowPositions = new Float32Array(vertexCount * 3);

    const shaftWidth = 0.4;
    const headWidth = 1.2;
    const headStartsAt = 0.4 * radius;

    for (let i = 0; i < vertexCount; i++) {
      const i3 = i * 3;
      const x = originalPositions.getX(i);
      const y = originalPositions.getY(i);
      const z = originalPositions.getZ(i);

      // Right Arrow
      let targetY = y;
      let targetZ = z;
      if (x < headStartsAt) {
        // Shaft
        targetY *= shaftWidth;
        targetZ *= shaftWidth;
      } else {
        // Head
        const headProgress = (x - headStartsAt) / (radius - headStartsAt); // 0 to 1
        const currentWidth = THREE.MathUtils.lerp(
          headWidth,
          0.1,
          headProgress * headProgress,
        );
        targetY *= currentWidth;
        targetZ *= currentWidth;
      }

      rightArrowPositions[i3] = x * 1.5;
      rightArrowPositions[i3 + 1] = targetY;
      rightArrowPositions[i3 + 2] = targetZ;

      // Left Arrow (mirrored)
      targetY = y; // reset
      targetZ = z; // reset
      if (-x < headStartsAt) {
        // Shaft
        targetY *= shaftWidth;
        targetZ *= shaftWidth;
      } else {
        // Head
        const headProgress = (-x - headStartsAt) / (radius - headStartsAt); // 0 to 1
        const currentWidth = THREE.MathUtils.lerp(
          headWidth,
          0.1,
          headProgress * headProgress,
        );
        targetY *= currentWidth;
        targetZ *= currentWidth;
      }

      leftArrowPositions[i3] = x * 1.5;
      leftArrowPositions[i3 + 1] = targetY;
      leftArrowPositions[i3 + 2] = targetZ;
    }

    geometry.morphAttributes.position = [];
    geometry.morphAttributes.position[0] = new THREE.BufferAttribute(
      leftArrowPositions,
      3,
    );
    geometry.morphAttributes.position[1] = new THREE.BufferAttribute(
      rightArrowPositions,
      3,
    );

    new EXRLoader().load('piz_compressed.exr', (texture: THREE.Texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const exrCubeRenderTarget = pmremGenerator.fromEquirectangular(texture);
      sphereMaterial.envMap = exrCubeRenderTarget.texture;
      sphere.visible = true;
    });

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: 0xcc0000,
      metalness: 0.5,
      roughness: 0.1,
      emissive: 0x330000,
      emissiveIntensity: 1.5,
    });
    // FIX: The `morphTargets` property must be set to true on the material to enable morph targets.
    sphereMaterial.morphTargets = true;

    sphereMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = {value: 0};
      shader.uniforms.inputData = {value: new THREE.Vector4()};
      shader.uniforms.outputData = {value: new THREE.Vector4()};

      sphereMaterial.userData.shader = shader;

      shader.vertexShader = sphereVS;
    };

    const sphere = new THREE.Mesh(geometry, sphereMaterial);
    sphere.morphTargetInfluences = [0, 0];
    scene.add(sphere);
    sphere.visible = false;

    this.sphere = sphere;

    const renderPass = new RenderPass(scene, camera);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      5,
      0.5,
      0,
    );

    const fxaaPass = new ShaderPass(FXAAShader);

    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    this.composer = composer;

    function onWindowResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      const dPR = renderer.getPixelRatio();
      const w = window.innerWidth;
      const h = window.innerHeight;
      backdrop.material.uniforms.resolution.value.set(w * dPR, h * dPR);
      renderer.setSize(w, h);
      composer.setSize(w, h);
      fxaaPass.material.uniforms['resolution'].value.set(
        1 / (w * dPR),
        1 / (h * dPR),
      );
    }

    window.addEventListener('resize', onWindowResize);
    onWindowResize();

    this.animation();
  }

  private animation() {
    requestAnimationFrame(() => this.animation());

    this.inputAnalyser.update();
    this.outputAnalyser.update();

    const t = performance.now();
    const dt = (t - this.prevTime) / (1000 / 60);
    this.prevTime = t;
    const backdropMaterial = this.backdrop.material as THREE.RawShaderMaterial;
    const sphereMaterial = this.sphere.material as THREE.MeshStandardMaterial;

    backdropMaterial.uniforms.rand.value = Math.random() * 10000;

    const morphSpeed = 0.05 * dt;
    if (this.isMorphingIn) {
      this.morphProgress = Math.min(1, this.morphProgress + morphSpeed);
    } else {
      this.morphProgress = Math.max(0, this.morphProgress - morphSpeed);
    }

    if (this.sphere.morphTargetInfluences) {
      this.sphere.morphTargetInfluences.fill(0);
      if (this.morphTargetIndex !== -1) {
        this.sphere.morphTargetInfluences[this.morphTargetIndex] =
          this.morphProgress;
      }
    }

    if (this.morphProgress === 0 && !this.isMorphingIn) {
      this.morphTargetIndex = -1;
    }

    const isMorphed = this.morphProgress > 0;

    if (sphereMaterial.userData.shader) {
      if (!isMorphed) {
        this.sphere.scale.setScalar(
          1 + (0.2 * this.outputAnalyser.data[1]) / 255,
        );

        const f = 0.001;
        this.rotation.x += (dt * f * 0.5 * this.outputAnalyser.data[1]) / 255;
        this.rotation.z += (dt * f * 0.5 * this.inputAnalyser.data[1]) / 255;
        this.rotation.y += (dt * f * 0.25 * this.inputAnalyser.data[2]) / 255;
        this.rotation.y += (dt * f * 0.25 * this.outputAnalyser.data[2]) / 255;

        const euler = new THREE.Euler(
          this.rotation.x,
          this.rotation.y,
          this.rotation.z,
        );
        const quaternion = new THREE.Quaternion().setFromEuler(euler);
        const targetPos = new THREE.Vector3(0, 0, 5);
        targetPos.applyQuaternion(quaternion);
        this.camera.position.lerp(targetPos, 0.1);

        sphereMaterial.userData.shader.uniforms.time.value +=
          (dt * 0.1 * this.outputAnalyser.data[0]) / 255;
        sphereMaterial.userData.shader.uniforms.inputData.value.set(
          (1 * this.inputAnalyser.data[0]) / 255,
          (0.1 * this.inputAnalyser.data[1]) / 255,
          (10 * this.inputAnalyser.data[2]) / 255,
          0,
        );
        sphereMaterial.userData.shader.uniforms.outputData.value.set(
          (2 * this.outputAnalyser.data[0]) / 255,
          (0.1 * this.outputAnalyser.data[1]) / 255,
          (10 * this.outputAnalyser.data[2]) / 255,
          0,
        );
      } else {
        this.sphere.scale.setScalar(1);
        const targetPos = new THREE.Vector3(0, 0, 7);
        this.camera.position.lerp(targetPos, 0.1);

        // Reset uniforms to stop distortion
        sphereMaterial.userData.shader.uniforms.time.value = 0;
        sphereMaterial.userData.shader.uniforms.inputData.value.set(0, 0, 0, 0);
        sphereMaterial.userData.shader.uniforms.outputData.value.set(
          0,
          0,
          0,
          0,
        );
      }
      this.camera.lookAt(this.sphere.position);
    }

    this.composer.render();
  }

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas') as HTMLCanvasElement;
    this.init();
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-3d': GdmLiveAudioVisuals3D;
  }
}
