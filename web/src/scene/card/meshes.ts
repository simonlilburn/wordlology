// Meshes showing a CardFace: the face plane and the density-ghost plane on
// top of it. Each layer owns its own meshes; faces (textures) are shared.

import * as THREE from 'three';
import type { Rect } from '../atlas/layout';
import type { director as Dir } from './director';
import { GHOST_RECT, type CardFace } from './face';

const plane = new THREE.PlaneGeometry(1, 1);

function material(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    opacity: 0,
  });
}

export class CardMeshes {
  group = new THREE.Group();
  faceMat = material();
  ghostMat = material();
  face: THREE.Mesh;
  ghost: THREE.Mesh;
  bound: CardFace | null = null;

  constructor(renderOrder = 10) {
    this.face = new THREE.Mesh(plane, this.faceMat);
    this.ghost = new THREE.Mesh(plane, this.ghostMat);
    this.face.renderOrder = renderOrder;
    this.ghost.renderOrder = renderOrder + 1;
    this.face.frustumCulled = false;
    this.ghost.frustumCulled = false;
    this.group.add(this.face, this.ghost);
  }

  /** Show `face` (textures may be replaced when a face changes resolution). */
  bind(face: CardFace | null): void {
    this.bound = face;
    const fm = face?.texture ?? null, gm = face?.ghostTexture ?? null;
    if (this.faceMat.map !== fm) {
      this.faceMat.map = fm;
      this.faceMat.needsUpdate = true;
    }
    if (this.ghostMat.map !== gm) {
      this.ghostMat.map = gm;
      this.ghostMat.needsUpdate = true;
    }
  }

  /** Place over a layout rect at world depth `wz`. */
  place(d: typeof Dir, r: Rect, wz = 0): void {
    const c = d.layoutToWorld(r.x + r.w / 2, r.y + r.h / 2);
    this.face.position.set(c.x, c.y, wz);
    this.face.scale.set(r.w, r.h * d.yUp, 1);
    const gx = r.x + (GHOST_RECT.x / 360) * r.w;
    const gy = r.y + (GHOST_RECT.y / 480) * r.h;
    const gw = (GHOST_RECT.w / 360) * r.w, gh = (GHOST_RECT.h / 480) * r.h;
    const g = d.layoutToWorld(gx + gw / 2, gy + gh / 2);
    this.ghost.position.set(g.x, g.y, wz + 0.01);
    this.ghost.scale.set(gw, gh * d.yUp, 1);
  }

  setAlpha(face: number, ghost: number): void {
    this.faceMat.opacity = face;
    this.ghostMat.opacity = ghost;
    this.face.visible = face > 0.003 && !!this.faceMat.map;
    this.ghost.visible = ghost > 0.003 && !!this.ghostMat.map;
    this.group.visible = this.face.visible || this.ghost.visible;
  }

  dispose(): void {
    this.faceMat.dispose();
    this.ghostMat.dispose();
  }
}
