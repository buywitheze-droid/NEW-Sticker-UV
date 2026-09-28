// Thin message-handling wrapper; the contour-tracing algorithm itself lives in ./contour-trace-core.
import {
  WorkerMessage,
  WorkerResponse,
  BezierPath,
  MAX_SAFE_DIMENSION,
  postProgress,
  downscaleImageData,
  upscaleImageData,
  processContour,
  bezierPathScale,
} from './contour-trace-core';

self.onmessage = function(e: MessageEvent<WorkerMessage>) {
  const { type, imageData, strokeSettings, effectiveDPI, previewMode, detectedShapeType, detectedShapeBBox } = e.data;
  
  if (type === 'process') {
    try {
      postProgress(10);
      
      // Determine target dimension based on mode
      // Preview mode: 400px for instant rendering
      // Non-preview: 4000px max to prevent browser crashes
      const maxPreviewDimension = 400;
      const maxDim = Math.max(imageData.width, imageData.height);
      
      let targetMaxDim: number;
      if (previewMode && maxDim > maxPreviewDimension) {
        targetMaxDim = maxPreviewDimension;
      } else if (maxDim > MAX_SAFE_DIMENSION) {
        targetMaxDim = MAX_SAFE_DIMENSION;
      } else {
        targetMaxDim = maxDim; // No scaling needed
      }
      
      const shouldDownscale = maxDim > targetMaxDim;
      
      let processedData: ImageData;
      let contourData: WorkerResponse['contourData'];
      let scale = 1;
      
      let imageCanvasX = 0;
      let imageCanvasY = 0;
      let detectedAlg: 'complex' | 'scattered' = 'complex';
      
      if (shouldDownscale) {
        scale = targetMaxDim / maxDim;
        const scaledWidth = Math.round(imageData.width * scale);
        const scaledHeight = Math.round(imageData.height * scale);
        const scaledData = downscaleImageData(imageData, scaledWidth, scaledHeight);
        const scaledDPI = effectiveDPI * scale;
        
        postProgress(15);
        const scaledBBox = detectedShapeBBox ? {
          x: Math.round(detectedShapeBBox.x * scale),
          y: Math.round(detectedShapeBBox.y * scale),
          width: Math.round(detectedShapeBBox.width * scale),
          height: Math.round(detectedShapeBBox.height * scale)
        } : null;
        const result = processContour(scaledData, strokeSettings, scaledDPI, previewMode, detectedShapeType, scaledBBox);
        postProgress(90);
        
        processedData = upscaleImageData(result.imageData, 
          Math.round(result.imageData.width / scale), 
          Math.round(result.imageData.height / scale));

        const rescaledPreviewPts = result.contourData.previewPathPoints.map(p => ({
          x: p.x / scale,
          y: p.y / scale
        }));

        // Physical PDF coordinates are already computed by the trace core.
        // Scaling the pixels back must not derive a new bounding box from the
        // first path (which can exclude other paths or holes), nor assume a
        // different bleed. Preserve the core's page and PDF coordinates.

        // Rescale allPreviewPathPoints and recompute allPathPoints if present (zero hero mode)
        let rescaledAllPreview: Array<Array<{x: number; y: number}>> | undefined;
        if (result.contourData.allPreviewPathPoints && result.contourData.allPreviewPathPoints.length > 0) {
          rescaledAllPreview = result.contourData.allPreviewPathPoints.map(pts =>
            pts.map(p => ({ x: p.x / scale, y: p.y / scale }))
          );
        }

        // Same dance for the bezier representation: each path's anchors and
        // control points live in the same scaled-image pixel space as the
        // polylines, so we apply the identical rescale + image-origin shift +
        // pixel→inch + Y-flip transform.
        let rescaledAllBezierPreview: BezierPath[] | undefined;
        if (result.contourData.allBezierPathsPreview && result.contourData.allBezierPathsPreview.length > 0) {
          rescaledAllBezierPreview = result.contourData.allBezierPathsPreview.map(bp =>
            bezierPathScale(bp, 1 / scale)
          );
        }

        contourData = {
          ...result.contourData,
          previewPathPoints: rescaledPreviewPts,
          allPreviewPathPoints: rescaledAllPreview,
          allBezierPathsPreview: rescaledAllBezierPreview,
          effectiveDPI,
          minPathX: result.contourData.minPathX / scale,
          minPathY: result.contourData.minPathY / scale,
        };
        imageCanvasX = Math.round(result.imageCanvasX / scale);
        imageCanvasY = Math.round(result.imageCanvasY / scale);
        detectedAlg = result.detectedAlgorithm;

      } else {
        const result = processContour(imageData, strokeSettings, effectiveDPI, previewMode, detectedShapeType, detectedShapeBBox);
        processedData = result.imageData;
        contourData = result.contourData;
        imageCanvasX = result.imageCanvasX;
        imageCanvasY = result.imageCanvasY;
        detectedAlg = result.detectedAlgorithm;

      }
      
      postProgress(100);
      
      const response: WorkerResponse = {
        type: 'result',
        imageData: processedData,
        imageCanvasX,
        imageCanvasY,
        contourData: contourData,
        detectedAlgorithm: detectedAlg
      };
      (self as unknown as Worker).postMessage(response, [processedData.data.buffer]);
    } catch (error) {
      const response: WorkerResponse = {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      self.postMessage(response);
    }
  }
};
