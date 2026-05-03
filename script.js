import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const API_TIMEOUT_MS = 60_000;

const DEFAULT_CONFIG = {
    AI_PROVIDER: 'pollinations',
    IMAGE_PROVIDER: 'pollinations',
    POLLINATIONS_API_BASE_URL: 'https://gen.pollinations.ai',
    POLLINATIONS_IMAGE_BASE_URL: 'https://gen.pollinations.ai/image',
    POLLINATIONS_API_KEY: '',
    POLLINATIONS_IMAGE_MODEL: 'flux'
};

function getConfig() {
    if (typeof window === 'undefined') {
        return { ...DEFAULT_CONFIG };
    }

    return {
        ...DEFAULT_CONFIG,
        ...(window.PANORAMIC_SCENE_CONFIG || {})
    };
}

function getImageProvider() {
    const config = getConfig();
    return config.IMAGE_PROVIDER || config.AI_PROVIDER;
}

function normalizeBaseUrl(url) {
    return String(url || '').replace(/\/$/, '');
}

function generateSeed() {
    return Math.floor(Math.random() * 1_000_000);
}

function buildPanoramaPrompt(userPrompt) {
    return `Equirectangular 360-degree panorama of ${userPrompt}. Full wrap-around spherical image with consistent horizon.`;
}

const POLLINATIONS_IMAGE_MODELS_ENDPOINT = 'https://gen.pollinations.ai/image/models';
const FALLBACK_IMAGE_MODELS = [
    { value: 'flux', label: 'flux' },
    { value: 'kontext', label: 'kontext' },
    { value: 'gptimage', label: 'gptimage' }
];

function dedupeModels(models) {
    const seen = new Set();
    return models.filter(model => {
        if (!model?.value || seen.has(model.value)) {
            return false;
        }
        seen.add(model.value);
        return true;
    });
}

async function fetchImageModels() {
    try {
        const response = await fetchWithTimeout(POLLINATIONS_IMAGE_MODELS_ENDPOINT);
        const catalog = await response.json();

        if (!Array.isArray(catalog)) {
            throw new Error('Unexpected image model response.');
        }

        const models = catalog
            .filter(model => model.paid_only !== true)
            .filter(model => {
                const modalities = Array.isArray(model.output_modalities) ? model.output_modalities : [];
                return modalities.includes('image') && !modalities.includes('video');
            })
            .map(model => ({
                value: model.name,
                label: model.name
            }));

        const deduped = dedupeModels(models);
        return deduped.length ? deduped : FALLBACK_IMAGE_MODELS;
    } catch (error) {
        console.warn('Failed to fetch Pollinations image models. Using fallback list.', error);
        return FALLBACK_IMAGE_MODELS;
    }
}

function populateModelSelect(selectElement, models, defaultValue) {
    selectElement.innerHTML = '';
    models.forEach(({ value, label }) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if (value === defaultValue) {
            option.selected = true;
        }
        selectElement.appendChild(option);
    });
}

function resolveSelectedModel(models, preferredValue) {
    if (models.some(model => model.value === preferredValue)) {
        return preferredValue;
    }
    return models[0]?.value || preferredValue;
}

function getImageConfigurationError() {
    const config = getConfig();
    const provider = getImageProvider();

    if (provider !== 'pollinations') {
        return `Unsupported image provider: ${provider}`;
    }

    if (!config.POLLINATIONS_API_KEY) {
        return 'Image generation requires a Pollinations API key. Add POLLINATIONS_API_KEY in config.js.';
    }

    return '';
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Request timed out after 60 s. Check your connection and try again.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function urlToDataUrl(url) {
    const response = await fetchWithTimeout(url);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result;
            if (typeof result === 'string') {
                resolve(result);
            } else {
                reject(new Error('Failed to convert image to data URL.'));
            }
        };
        reader.onerror = () => reject(new Error('Failed to read generated image blob.'));
        reader.readAsDataURL(blob);
    });
}

async function generatePanoramaImageDataUrl(prompt, seed) {
    const config = getConfig();
    const provider = getImageProvider();

    if (provider !== 'pollinations') {
        throw new Error(`Unsupported image provider: ${provider}`);
    }

    const baseUrl = normalizeBaseUrl(config.POLLINATIONS_IMAGE_BASE_URL);
    const imageUrl = new URL(`${baseUrl}/${encodeURIComponent(buildPanoramaPrompt(prompt))}`);
    imageUrl.searchParams.set('model', config.POLLINATIONS_IMAGE_MODEL);
    imageUrl.searchParams.set('seed', String(seed));
    // Request 2:1 ratio required for equirectangular panorama projection.
    imageUrl.searchParams.set('width', '2048');
    imageUrl.searchParams.set('height', '1024');
    imageUrl.searchParams.set('nologo', 'true');

    if (config.POLLINATIONS_API_KEY) {
        imageUrl.searchParams.set('key', config.POLLINATIONS_API_KEY);
    }

    return await urlToDataUrl(imageUrl.toString());
}

class PanoramaViewer {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.currentTexture = null;
        this.showGridOverlay = true;
        
        this.init();
        this.setupEventListeners();
    }
    
    init() {
        // Setup three.js scene
        this.scene = new THREE.Scene();
        
        // Setup camera — aspect from viewer element to avoid distortion;
        // FOV 65° reduces edge stretching vs 75°; camera at origin for a true spherical view.
        const viewerEl = document.getElementById('viewer');
        const initAspect = viewerEl.clientWidth / (viewerEl.clientHeight || 1) || 16 / 9;
        this.camera = new THREE.PerspectiveCamera(65, initAspect, 0.1, 1000);
        this.camera.position.set(0, 0, 0);
        
        // Setup renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        const viewerElement = document.getElementById('viewer');
        this.renderer.setSize(viewerElement.clientWidth, viewerElement.clientHeight);
        viewerElement.appendChild(this.renderer.domElement);
        
        // Create a sphere geometry for the panorama
        const geometry = new THREE.SphereGeometry(500, 60, 40);
        // Invert the geometry so that the texture renders on the inside
        geometry.scale(-1, 1, 1);
        
        // Create a placeholder material
        const placeholderTexture = this.createPlaceholderTexture();
        const material = new THREE.MeshBasicMaterial({ map: placeholderTexture });
        
        // Create the panoramic sphere
        this.sphere = new THREE.Mesh(geometry, material);
        this.scene.add(this.sphere);
        
        // Add OrbitControls to navigate the panorama
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableZoom = false;
        this.controls.enablePan = false;
        this.controls.rotateSpeed = 0.3;
        // Clamp vertical look angle to avoid pole singularities and extreme distortion.
        this.controls.minPolarAngle = Math.PI * 0.15; // ~27° from top
        this.controls.maxPolarAngle = Math.PI * 0.85; // ~27° from bottom
        
        // Start animation loop
        this.animate();
        
        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());
    }
    
    createPlaceholderTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 2048;
        canvas.height = 1024;
        const context = canvas.getContext('2d');
        
        // Fill with gradient
        const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, '#87CEEB'); // Sky blue
        gradient.addColorStop(0.5, '#ADD8E6'); // Light blue
        gradient.addColorStop(1, '#90EE90'); // Light green
        
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw equirectangular grid for debugging
        this.drawEquirectangularGrid(context, canvas.width, canvas.height);
        
        // Add text
        context.font = 'bold 80px Arial';
        context.textAlign = 'center';
        context.fillStyle = 'rgba(255, 255, 255, 0.7)';
        context.fillText('Generate a panorama', canvas.width / 2, canvas.height / 2);
        
        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        return texture;
    }
    
    drawEquirectangularGrid(ctx, width, height) {
        // Draw longitude lines (vertical)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 2;
        
        // 24 longitude lines (every 15 degrees)
        for (let i = 0; i <= 24; i++) {
            const x = i * (width / 24);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
            
            // Add longitude labels (in degrees)
            if (i % 2 === 0) {
                const degrees = i * 15 - 180;
                ctx.font = '20px Arial';
                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.textAlign = 'center';
                ctx.fillText(`${degrees}°`, x, 30);
            }
        }
        
        // Draw latitude lines (horizontal)
        // 12 latitude lines (every 15 degrees)
        for (let i = 0; i <= 12; i++) {
            const y = i * (height / 12);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
            
            // Add latitude labels (in degrees)
            if (i % 2 === 0) {
                const degrees = 90 - i * 15;
                ctx.font = '20px Arial';
                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.textAlign = 'left';
                ctx.fillText(`${degrees}°`, 10, y + 20);
            }
        }
        
        // Add cardinal directions
        ctx.font = 'bold 30px Arial';
        ctx.fillStyle = 'rgba(255, 200, 200, 0.8)';
        ctx.textAlign = 'center';
        // North (middle top)
        ctx.fillText('N', width / 2, 60);
        // South (middle bottom)
        ctx.fillText('S', width / 2, height - 30);
        // East (3/4 of width)
        ctx.fillText('E', width * 0.75, height / 2);
        // West (1/4 of width)
        ctx.fillText('W', width * 0.25, height / 2);
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
    
    onWindowResize() {
        const viewerElement = document.getElementById('viewer');
        this.camera.aspect = viewerElement.clientWidth / viewerElement.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(viewerElement.clientWidth, viewerElement.clientHeight);
    }
    
    updatePanorama(imageUrl) {
        // Remove old texture
        if (this.currentTexture) {
            this.currentTexture.dispose();
        }
        
        // Load new texture
        const textureLoader = new THREE.TextureLoader();
        textureLoader.crossOrigin = 'anonymous';
        textureLoader.load(
            imageUrl,
            (texture) => {
                // Process the texture to fix seam issues
                this.processTextureSeams(texture).then(processedTexture => {
                    this.currentTexture = processedTexture;
                    
                    // Apply texture to the sphere
                    this.sphere.material.map = processedTexture;
                    
                    // Add debug grid overlay if enabled
                    if (this.showGridOverlay) {
                        this.addDebugGridOverlay();
                    } else {
                        this.removeDebugGridOverlay();
                    }
                    
                    this.sphere.material.needsUpdate = true;
                    document.getElementById('loading').classList.add('hidden');
                });
            },
            undefined,
            (error) => {
                console.error('Error loading panorama texture:', error);
                document.getElementById('loading').classList.add('hidden');
                alert('Failed to load panorama. Please try again.');
            }
        );
    }
    
    async processTextureSeams(texture) {
        // Create a canvas to process the texture
        const canvas = document.createElement('canvas');
        const image = texture.image;
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        
        // Draw the original texture
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        
        // Get image data
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const source = new Uint8ClampedArray(data);

        // Pick blend width based on how different the two seam edges are.
        const edgeDiff = this.measureEdgeDifference(source, canvas.width, canvas.height);
        const minBlendWidth = Math.max(2, Math.floor(canvas.width * 0.004));
        const maxBlendWidth = Math.max(minBlendWidth + 1, Math.floor(canvas.width * 0.03));
        const normalizedDiff = Math.max(0, Math.min(1, edgeDiff / 48));
        const blendWidth = Math.max(
            minBlendWidth,
            Math.min(maxBlendWidth, Math.round(minBlendWidth + (maxBlendWidth - minBlendWidth) * normalizedDiff))
        );

        const smoothstep = (t) => t * t * (3 - 2 * t);

        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < blendWidth; x++) {
                const leftX = x;
                const rightX = canvas.width - 1 - x;
                const leftIdx = (y * canvas.width + leftX) * 4;
                const rightIdx = (y * canvas.width + rightX) * 4;

                // Strong near the seam edge, fades to zero toward interior.
                const t = blendWidth > 1 ? x / (blendWidth - 1) : 0;
                const influence = smoothstep(1 - t);

                for (let c = 0; c < 3; c++) {
                    const left = source[leftIdx + c];
                    const right = source[rightIdx + c];
                    const avg = 0.5 * (left + right);

                    data[leftIdx + c] = Math.round(left * (1 - influence) + avg * influence);
                    data[rightIdx + c] = Math.round(right * (1 - influence) + avg * influence);
                }

                // Keep alpha channel stable and deterministic.
                data[leftIdx + 3] = source[leftIdx + 3];
                data[rightIdx + 3] = source[rightIdx + 3];
            }
        }
        
        // Put the modified image data back
        ctx.putImageData(imageData, 0, 0);
        
        // Create a new texture from the processed canvas
        const processedTexture = new THREE.CanvasTexture(canvas);
        processedTexture.wrapS = THREE.RepeatWrapping; // Important for proper wrapping
        processedTexture.wrapT = THREE.ClampToEdgeWrapping;
        processedTexture.minFilter = THREE.LinearMipmapLinearFilter;
        processedTexture.magFilter = THREE.LinearFilter;
        processedTexture.generateMipmaps = true;
        processedTexture.needsUpdate = true;
        
        return processedTexture;
    }

    measureEdgeDifference(data, width, height) {
        let total = 0;
        for (let y = 0; y < height; y++) {
            const leftIdx = (y * width) * 4;
            const rightIdx = (y * width + (width - 1)) * 4;

            total += Math.abs(data[leftIdx] - data[rightIdx]);
            total += Math.abs(data[leftIdx + 1] - data[rightIdx + 1]);
            total += Math.abs(data[leftIdx + 2] - data[rightIdx + 2]);
        }

        return total / (height * 3);
    }
    
    addDebugGridOverlay() {
        // Create canvas for the debug grid
        const canvas = document.createElement('canvas');
        canvas.width = 2048;
        canvas.height = 1024;
        const context = canvas.getContext('2d');
        
        // Make the canvas transparent
        context.fillStyle = 'rgba(0, 0, 0, 0)';
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw equirectangular grid
        this.drawEquirectangularGrid(context, canvas.width, canvas.height);
        
        // Create texture for debug grid
        const gridTexture = new THREE.CanvasTexture(canvas);
        gridTexture.needsUpdate = true;
        
        // Update material to show both textures
        if (this.sphere.material.map) {
            const baseTexture = this.sphere.material.map;
            
            // Create new material that combines both textures
            const newMaterial = new THREE.MeshBasicMaterial({
                map: baseTexture
            });
            
            // Add grid as second texture in a custom shader material
            this.sphere.material = new THREE.ShaderMaterial({
                uniforms: {
                    baseTexture: { value: baseTexture },
                    gridTexture: { value: gridTexture }
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D baseTexture;
                    uniform sampler2D gridTexture;
                    varying vec2 vUv;
                    void main() {
                        vec4 baseColor = texture2D(baseTexture, vUv);
                        vec4 gridColor = texture2D(gridTexture, vUv);
                        // Blend the textures (grid overlay on top of base image)
                        gl_FragColor = mix(baseColor, gridColor, gridColor.a);
                    }
                `
            });
        }
    }
    
    removeDebugGridOverlay() {
        // Just reset to basic material with only the base texture
        if (this.currentTexture) {
            this.sphere.material = new THREE.MeshBasicMaterial({
                map: this.currentTexture
            });
            this.sphere.material.needsUpdate = true;
        }
    }
    
    toggleGridOverlay() {
        this.showGridOverlay = !this.showGridOverlay;
        
        if (this.currentTexture) {
            if (this.showGridOverlay) {
                this.addDebugGridOverlay();
            } else {
                this.removeDebugGridOverlay();
            }
        }
    }
    
    setupEventListeners() {
        const generateBtn = document.getElementById('generateBtn');
        generateBtn.addEventListener('click', () => this.generatePanorama());
        
        const retryBtn = document.getElementById('retryBtn');
        retryBtn.addEventListener('click', () => {
            // Use a different seed for variation
            const currentSeed = Math.floor(Math.random() * 1000);
            this.generatePanorama(currentSeed);
            
            const statusMessage = document.getElementById('status-message');
            statusMessage.textContent = "Trying with a different seed variation...";
            statusMessage.classList.remove('hidden', 'error');
            statusMessage.classList.add('success');
        });
        
        const toggleOverlayBtn = document.getElementById('toggleOverlayBtn');
        toggleOverlayBtn.addEventListener('click', () => {
            this.toggleGridOverlay();
            toggleOverlayBtn.textContent = this.showGridOverlay ? "Hide Grid Overlay" : "Show Grid Overlay";
        });

        const imageModelSelect = document.getElementById('imageModelSelect');
        imageModelSelect.addEventListener('change', () => {
            window.PANORAMIC_SCENE_CONFIG = {
                ...(window.PANORAMIC_SCENE_CONFIG || {}),
                POLLINATIONS_IMAGE_MODEL: imageModelSelect.value
            };
        });
    }
    
    async generatePanorama(specificSeed = null) {
        const promptInput = document.getElementById('prompt');
        const prompt = promptInput.value.trim();
        
        if (!prompt) {
            alert('Please enter a description for your panorama');
            return;
        }
        
        const loadingElem = document.getElementById('loading');
        loadingElem.classList.remove('hidden');
        
        const generateBtn = document.getElementById('generateBtn');
        const retryBtn = document.getElementById('retryBtn');
        generateBtn.disabled = true;
        retryBtn.disabled = true;
        
        const statusMessage = document.getElementById('status-message');
        statusMessage.classList.remove('hidden', 'error', 'success');
        statusMessage.textContent = "Generating your panorama...";

        const configError = getImageConfigurationError();
        if (configError) {
            statusMessage.textContent = configError;
            statusMessage.classList.add('error');
            loadingElem.classList.add('hidden');
            generateBtn.disabled = false;
            retryBtn.disabled = false;
            return;
        }
        
        try {
            // Try up to 3 times with different seeds if needed
            let result;
            let attempts = 0;
            let maxAttempts = 3;
            
            while (attempts < maxAttempts) {
                try {
                    const seed = specificSeed || generateSeed();
                    result = await generatePanoramaImageDataUrl(prompt, seed);
                    
                    // If we get here, generation was successful
                    break;
                } catch (e) {
                    attempts++;
                    console.log(`Attempt ${attempts} failed, trying again...`);
                    
                    // If this was the last attempt, rethrow the error
                    if (attempts >= maxAttempts) throw e;
                    
                    // Wait a moment before trying again
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            statusMessage.textContent = "Panorama generated successfully!";
            statusMessage.classList.add('success');
            this.updatePanorama(result);
        } catch (error) {
            console.error('Error generating panorama:', error);
            
            statusMessage.textContent = "Could not generate custom panorama. Showing a similar preset panorama instead.";
            statusMessage.classList.add('error');
            
            // Use fallback panorama directly without alert
            const placeholderUrl = this.getPlaceholderPanoramaUrl(prompt);
            this.updatePanorama(placeholderUrl);
        } finally {
            generateBtn.disabled = false;
            retryBtn.disabled = false;
        }
    }
    
    getPlaceholderPanoramaUrl(prompt) {
        // Expanded keyword matching for better fallback selection
        const promptLower = prompt.toLowerCase();
        
        // Nature scenes
        if (promptLower.includes('mountain') || promptLower.includes('peak') || promptLower.includes('hill')) {
            return "https://images.unsplash.com/photo-1520962880247-cfaf541c8724?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        } else if (promptLower.includes('lake') || promptLower.includes('river') || promptLower.includes('waterfall')) {
            return "https://images.unsplash.com/photo-1488291855113-4e4193f50e53?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        } else if (promptLower.includes('forest') || promptLower.includes('tree') || promptLower.includes('wood')) {
            return "https://images.unsplash.com/photo-1448375240586-882707db888b?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        } else if (promptLower.includes('beach') || promptLower.includes('ocean') || promptLower.includes('sea') || promptLower.includes('coast')) {
            return "https://images.unsplash.com/photo-1566024287286-457247b70310?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        } else if (promptLower.includes('sunset') || promptLower.includes('sunrise') || promptLower.includes('sky')) {
            return "https://images.unsplash.com/photo-1444080748397-f442aa95c3e5?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        } else if (promptLower.includes('desert') || promptLower.includes('canyon') || promptLower.includes('sand')) {
            return "https://images.unsplash.com/photo-1512942050693-a8a90a414f32?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        } 
        // Urban scenes
        else if (promptLower.includes('city') || promptLower.includes('urban') || promptLower.includes('street') || promptLower.includes('building')) {
            return "https://images.unsplash.com/photo-1552832230-c0197dd311b5?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        }
        // Space and sky
        else if (promptLower.includes('space') || promptLower.includes('star') || promptLower.includes('galaxy') || promptLower.includes('cosmic')) {
            return "https://images.unsplash.com/photo-1465101162946-4377e57745c3?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        }
        // Snow and winter
        else if (promptLower.includes('snow') || promptLower.includes('winter') || promptLower.includes('ice')) {
            return "https://images.unsplash.com/photo-1491002052546-bf38f186af56?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        }
        // Fields and meadows
        else if (promptLower.includes('field') || promptLower.includes('meadow') || promptLower.includes('grass')) {
            return "https://images.unsplash.com/photo-1500382017468-9049fed747ef?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        }
        else {
            // Default nature panorama as final fallback
            return "https://images.unsplash.com/photo-1444080748397-f442aa95c3e5?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000&q=80";
        }
    }
}

// Initialize the panorama viewer when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const config = getConfig();
    const imageModelSelect = document.getElementById('imageModelSelect');
    if (imageModelSelect) {
        const preferredModel = config.POLLINATIONS_IMAGE_MODEL || 'flux';
        populateModelSelect(imageModelSelect, [{ value: preferredModel, label: 'Loading...' }], preferredModel);

        fetchImageModels()
            .then(models => {
                const selected = resolveSelectedModel(models, preferredModel);
                populateModelSelect(imageModelSelect, models, selected);
                window.PANORAMIC_SCENE_CONFIG = {
                    ...(window.PANORAMIC_SCENE_CONFIG || {}),
                    POLLINATIONS_IMAGE_MODEL: selected
                };
            })
            .catch(() => {
                // Keep placeholder option on fetch failure.
            });
    }
    new PanoramaViewer();
});