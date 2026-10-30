"""Offline camera fit from a four-fret corridor traced in a reference image.

Run with the optional calibration dependency group. No image libraries are
imported by the app. The original image is used to exclude existing magenta art.
The fit assumes square pixels, a centered principal point and a rectangular
highway plane; a single traced view does not establish Rocksmith's camera rig.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def fit_line(points):
    center = points.mean(axis=0)
    _, _, directions = np.linalg.svd(points - center, full_matrices=False)
    direction = directions[0]
    normal = np.array([-direction[1], direction[0]])
    return np.array([*normal, -normal @ center])


def intersect(first, second):
    value = np.cross(first, second)
    return value[:2] / value[2]


def extract_rails(original, marked, color):
    reference = np.asarray(original.convert("RGB"), dtype=np.float64)
    annotation = np.asarray(marked.convert("RGB"), dtype=np.float64)
    if reference.shape != annotation.shape:
        raise ValueError("Original and marked image dimensions must match")
    difference = np.max(np.abs(reference - annotation), axis=2)
    distance = np.linalg.norm(annotation - color, axis=2)
    mask = (difference > 20) & (distance < 35)
    mask[:int(mask.shape[0] * .25)] = False
    ys, xs = np.nonzero(mask)
    points = np.column_stack((xs, ys)).astype(float)
    if len(points) < 100:
        raise ValueError("Not enough annotation pixels were found")
    remaining = points.copy()
    rails = []
    rng = np.random.default_rng(0)
    for _ in range(2):
        best = np.zeros(len(remaining), dtype=bool)
        for _ in range(500):
            a, b = remaining[rng.choice(len(remaining), 2, replace=False)]
            delta = b - a
            if abs(delta[1]) < mask.shape[0] * .15:
                continue
            normal = np.array([-delta[1], delta[0]]) / np.linalg.norm(delta)
            inliers = np.abs((remaining - a) @ normal) < 3
            if inliers.sum() > best.sum():
                best = inliers
        line = fit_line(remaining[best])
        # Refit to the stroke's center, rather than one of its antialiased edges.
        selected = np.abs(remaining @ line[:2] + line[2]) < 3.2
        line = fit_line(remaining[selected])
        y = np.quantile(remaining[selected, 1], .998)
        near = np.array([-(line[1] * y + line[2]) / line[0], y])
        rails.append((line, near))
        remaining = remaining[~selected]
    rails.sort(key=lambda entry: entry[1][0])
    top_y = np.quantile(points[:, 1], .005)
    cap = points[np.abs(points[:, 1] - top_y) < 4]
    cap_line = fit_line(cap)
    left, right = rails
    corners = np.array([left[1], right[1], intersect(left[0], cap_line), intersect(right[0], cap_line)])
    return corners, intersect(left[0], right[0]), len(points)


def fit_camera(corners, width, height):
    # Homography from x in [0,4] and an arbitrary unit of forward depth.
    world = [(0, 0), (4, 0), (0, 1), (4, 1)]
    rows, values = [], []
    for (x, z), (u, v) in zip(world, corners):
        rows.extend([[x, z, 1, 0, 0, 0, -u*x, -u*z], [0, 0, 0, x, z, 1, -v*x, -v*z]])
        values.extend([u, v])
    homography = np.append(np.linalg.solve(rows, values), 1).reshape(3, 3)
    cx, cy = width / 2, height / 2
    a, b = homography[:, 0], homography[:, 1]
    numerator = (a[0] - cx*a[2]) * (b[0] - cx*b[2]) + (a[1] - cy*a[2]) * (b[1] - cy*b[2])
    focal_squared = -numerator / (a[2] * b[2])
    if focal_squared <= 0:
        raise ValueError("Traced lines do not give a physical centered perspective camera")
    focal = np.sqrt(focal_squared)
    intrinsic = np.array([[focal, 0, cx], [0, focal, cy], [0, 0, 1]])
    basis = np.linalg.solve(intrinsic, homography)
    unit = np.linalg.norm(basis[:, 0])
    depth = np.linalg.norm(basis[:, 1]) / unit
    rx = basis[:, 0] / unit
    rz = -basis[:, 1] / (unit * depth)  # Our future is negative world Z.
    ry = np.cross(rz, rx)
    rotation_cv = np.column_stack((rx, ry, rz))
    translation_cv = basis[:, 2] / unit
    # OpenCV x/right,y/down,z/forward -> Three.js x/right,y/up,z/back.
    conversion = np.diag([1, -1, -1])
    view = np.eye(4)
    view[:3, :3] = conversion @ rotation_cv
    view[:3, 3] = conversion @ translation_cv
    camera_world = np.linalg.inv(view)
    points = np.array([[0,0,0], [4,0,0], [0,0,-depth], [4,0,-depth]])
    camera_points = points @ rotation_cv.T + translation_cv
    image_points = camera_points @ intrinsic.T
    projected = image_points[:, :2] / image_points[:, 2:]
    return {
        "reference_size": [width, height],
        "corridor_width": 4,
        "depth": float(depth),
        "vertical_fov": float(np.degrees(2 * np.arctan(height / (2*focal)))),
        "camera_position": camera_world[:3, 3].tolist(),
        "camera_world_matrix": camera_world.T.flatten().tolist(),
        "reference_corners": corners.tolist(),
        "normalized_corners": (corners / [width, height]).tolist(),
        "rms_pixels": float(np.sqrt(np.mean((projected - corners)**2))),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("marked", type=Path)
    parser.add_argument("--color", default="EA3FF7")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    color = np.array([int(args.color[i:i+2], 16) for i in (0, 2, 4)])
    original, marked = Image.open(args.original), Image.open(args.marked)
    corners, vanishing, count = extract_rails(original, marked, color)
    result = fit_camera(corners, *original.size)
    result.update(annotation_color="#" + args.color, depth_vanishing_point=vanishing.tolist(), annotation_pixels=count)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
