export const API_BASE = '/mediflux-api/api';

/**
 * 请求 Mediflux API
 */
export async function fetchJSON(url) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Mediflux API Error: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

/**
 * 获取检查信息
 */
export async function getStudyMetadata(studyUID) {
  const url = new URL(
    `${API_BASE}/studymeta`,
    window.location.origin
  );

  url.searchParams.set('studyuid', studyUID);

  return fetchJSON(url.toString());
}

/**
 * 生成 DICOM 文件访问 URL
 *
 * StudyLocation存储在 Study 层，
 * 由 ZBDataSource 传入
 *  filename 格式：
 * \SeriesInstanceUID\SOPInstanceUID.dcm
 */

export function getDicomFileURL(studyLocation, instance) {

  if (!studyLocation) {
    throw new Error(
      'StudyLocation is missing.'
    );
  }

  const seriesUID = instance.SeriesInstanceUID ||
    instance.metadata?.SeriesInstanceUID;

  const sopUID = instance.SOPInstanceUID ||
    instance.metadata?.SOPInstanceUID;

  if (!seriesUID) {
    throw new Error('SeriesInstanceUID is missing.');
  }

  if (!sopUID) {
    throw new Error('SOPInstanceUID is missing.');
  }

  const filename = `\\${seriesUID}\\${sopUID}.dcm`;

  const url = new URL(
    `${API_BASE}/dcmfile`,
    window.location.origin
  );

  url.searchParams.set('pathname', studyLocation);
  url.searchParams.set('filename', filename);

  return url.toString();
}

/**
 * 生成 Cornerstone ImageId
 *
 * 使用 WADO-URI Loader 加载完整 DICOM 文件。
 */
export function getImageId(studyLocation, instance, frame) {
  if (instance.imageId && frame === undefined) {
    return instance.imageId;
  }

  const imageURL = instance.url || getDicomFileURL(studyLocation, instance);

  let imageId = imageURL.startsWith('wadouri:')
    ? imageURL
    : `wadouri:${imageURL}`;

  if (frame !== undefined) {
    const separator = imageId.includes('?') ? '&' : '?';
    imageId += `${separator}frame=${frame + 1}`;
  }

  return imageId;
}

/**
 * 递归处理 DICOM Sequence
 *
 * 保留 OHIF 原生 DicomJSONDataSource 的处理方式。
 */
export function wrapSequences(obj, OHIF) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const result = Array.isArray(obj) ? [] : {};

  Object.keys(obj).forEach(key => {
    const value = obj[key];

    if (value && typeof value === 'object') {
      result[key] = wrapSequences(value, OHIF);
    } else {
      result[key] = value;
    }

    if (key.endsWith('Sequence')) {
      result[key] = OHIF.utils.addAccessors(result[key]);
    }
  });

  return result;
}
