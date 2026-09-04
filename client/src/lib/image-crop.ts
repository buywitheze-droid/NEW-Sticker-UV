export function getImageBounds(image: HTMLImageElement): { x: number; y: number; width: number; height: number } {
  // Create a temporary canvas to analyze the image
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return { x: 0, y: 0, width: image.width, height: image.height };

  canvas.width = image.width;
  canvas.height = image.height;
  
  // Draw the image
  ctx.drawImage(image, 0, 0);
  
  // Get image data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = 0;
  let maxY = 0;
  
  // Find the exact bounding box of visible content (alpha > 10 to handle anti-aliasing)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const alpha = data[(y * canvas.width + x) * 4 + 3];
      
      if (alpha > 10) { // Visible pixel found (includes anti-aliased edges)
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  
  // If no non-transparent pixels found, return original dimensions
  if (minX > maxX || minY > maxY) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }
  
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

export function cropImageToContent(image: HTMLImageElement): HTMLCanvasElement | null {
  try {
    const bounds = getImageBounds(image);
    
    // Validate bounds
    if (bounds.width <= 0 || bounds.height <= 0) {
      console.warn('Invalid crop bounds, returning null');
      return null;
    }
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.error('Failed to get canvas context');
      return null;
    }
    
    const edgePad = 3;
    canvas.width = bounds.width + edgePad * 2;
    canvas.height = bounds.height + edgePad * 2;
    
    ctx.drawImage(
      image,
      bounds.x, bounds.y, bounds.width, bounds.height,
      edgePad, edgePad, bounds.width, bounds.height
    );
    
    return canvas;
  } catch (error) {
    console.error('Error cropping image:', error);
    return null;
  }
}