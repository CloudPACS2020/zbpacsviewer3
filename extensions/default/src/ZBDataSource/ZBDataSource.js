import {
  DicomMetadataStore,
  IWebApiDataSource,
} from '@ohif/core';

import OHIF from '@ohif/core';

import {
  getStudyMetadata,
  getImageId,
  wrapSequences,
} from './utils';

const metadataProvider = OHIF.classes.MetadataProvider;

/**
 * ZB PACS DataSource
 */
function createZBDataSource(dataSourceConfig, servicesManager) {

  const studyCache = new Map();

  // --------------------------------------------------
  // Study Cache
  // --------------------------------------------------

  /**
   * 查找 Study
   */
  function findStudy(studyUID) {
    return studyCache.get(studyUID);
  }

  /**
   * 注册 ImageId 与 DICOM UID 的映射
   */
  function registerImageIds(study) {

    study.series.forEach(series => {

      series.instances.forEach(instance => {

        const metadata = instance.metadata;

        const imageId = getZBImageId(instance);

        metadataProvider.addImageIdToUIDs(imageId, {

          StudyInstanceUID: study.StudyInstanceUID,

          SeriesInstanceUID: series.SeriesInstanceUID,

          SOPInstanceUID: metadata.SOPInstanceUID,

        });

      });

    });

  }

  // --------------------------------------------------
  // ImageId
  // --------------------------------------------------

  /**
   * 获取 ZB PACS ImageId
   *
   * 根据 Instance 的 StudyInstanceUID，
   * 从 studyCache 中取得 StudyLocation。
   */
  function getZBImageId(instance, frame) {

    const studyUID = instance.StudyInstanceUID;

    if (!studyUID) {
      throw new Error(
        'Missing StudyInstanceUID in DICOM instance.'
      );
    }

    const study = findStudy(studyUID);

    if (!study || !study.StudyLocation) {
      throw new Error(
        `StudyLocation not found: ${studyUID}`
      );
    }

    return getImageId(
      study.StudyLocation,
      instance,
      frame
    );

  }

  // --------------------------------------------------
  // Initialize
  // --------------------------------------------------

  /**
   * 初始化 DataSource
   */
  async function initialize({ query }) {

    const studyUID =
      query.get('studyuid') ||
      query.get('StudyInstanceUID') ||
      query.get('StudyInstanceUIDs');

    if (!studyUID) {
      return [];
    }

    let study = findStudy(studyUID);

    if (!study) {

      const data = await getStudyMetadata(studyUID);

      if (!data || !data.studies) {
        throw new Error(
          'Invalid Mediflux Study Metadata.'
        );
      }

      study = data.studies.find(
        item => item.StudyInstanceUID === studyUID
      );

      if (!study) {
        throw new Error(
          `Study not found: ${studyUID}`
        );
      }

      studyCache.set(studyUID, study);

      registerImageIds(study);

    }

    return [studyUID];

  }

  // --------------------------------------------------
  // Query API
  // --------------------------------------------------

  const queryAPI = {

    studies: {

      mapParams: () => {},

      search: async params => {

        const [key, value] =
          Object.entries(params)[0] || [];

        const mapping = {

          studyInstanceUid: 'StudyInstanceUID',

          patientId: 'PatientID',

        };

        const field = mapping[key];

        if (!field) {
          return [];
        }

        const studies = Array.from(
          studyCache.values()
        );

        return studies

          .filter(study => study[field] === value)

          .map(study => ({

            accession: study.AccessionNumber,

            date: study.StudyDate,

            description: study.StudyDescription,

            instances: study.NumInstances,

            modalities: study.Modalities,

            mrn: study.PatientID,

            patientName: study.PatientName,

            studyInstanceUid: study.StudyInstanceUID,

            NumInstances: study.NumInstances,

            time: study.StudyTime,

          }));

      },

      processResults: () => {},

    },

    series: {

      search: async ({ StudyInstanceUID }) => {

        const study = findStudy(StudyInstanceUID);

        if (!study) {
          return [];
        }

        return study.series.map(series => ({

          ...series,

          StudyInstanceUID,

        }));

      },

    },

    instances: {

      search: async ({

        StudyInstanceUID,

        SeriesInstanceUID,

      }) => {

        const study = findStudy(StudyInstanceUID);

        if (!study) {
          return [];
        }

        const series = study.series.find(
          item =>
            item.SeriesInstanceUID === SeriesInstanceUID
        );

        return series?.instances || [];

      },

    },

  };

  // --------------------------------------------------
  // Retrieve API
  // --------------------------------------------------

  const retrieveAPI = {

    /**
     * 获取 Instance DICOM URL
     */
    directURL: ({ instance }) => {

      return instance.url || getZBImageId(instance);

    },

    series: {

      /**
       * 获取 Series Metadata
       *
       * 兼容 OHIF 3.13 returnPromises 机制。
       *
       * returnPromises = true:
       *   返回包含 start() 方法的对象数组。
       *
       * returnPromises = false:
       *   立即加载所有 Series Instance Metadata。
       */
      metadata: async ({

        StudyInstanceUID,

        filters = {},

        madeInClient = false,

        returnPromises = false,

        sortCriteria,

        sortFunction,

      }) => {

        const study = findStudy(StudyInstanceUID);

        if (!study) {
          throw new Error(
            `Study not found: ${StudyInstanceUID}`
          );
        }

        // --------------------------------------------
        // 1. 获取 Series 列表
        // --------------------------------------------

        let seriesList = [...study.series];

        // Series 过滤
        const filterUIDs =
          filters.SeriesInstanceUIDs ||
          filters.seriesInstanceUIDs;

        if (filterUIDs) {

          seriesList = seriesList.filter(series =>
            filterUIDs.includes(series.SeriesInstanceUID)
          );

        }

        // Series 排序
        if (typeof sortFunction === 'function') {

          seriesList = sortFunction(seriesList);

        }

        // --------------------------------------------
        // 2. 注册 Series Metadata
        // --------------------------------------------

        const seriesMetadata = seriesList.map(series => {

          const result = {

            ...series,

            StudyInstanceUID,

          };

          delete result.instances;

          return result;

        });

        DicomMetadataStore.addSeriesMetadata(
          seriesMetadata,
          madeInClient
        );

        // --------------------------------------------
        // 3. 创建 Series 延迟加载对象
        // --------------------------------------------

        const seriesPromises = seriesList.map(
          (series, index) => {

            let deliveredPromise;

            return {

              /**
               * Series Metadata
               */
              metadata: seriesMetadata[index],

              /**
               * 延迟加载当前 Series 的 Instance Metadata
               */
              start: () => {

                if (!deliveredPromise) {

                  deliveredPromise =
                    Promise.resolve().then(() => {

                      const allInstances =
                        series.instances.map(instance => {

                          const metadata = wrapSequences(
                            instance.metadata,
                            OHIF
                          );

                          const imageId =
                            getZBImageId(instance);

                          return {

                            ...metadata,

                            StudyInstanceUID,

                            SeriesInstanceUID:
                              series.SeriesInstanceUID,

                            url: imageId,

                            imageId,


                          };

                        });

                      // 注册当前 Series 的 Instance Metadata
                      DicomMetadataStore.addInstances(
                        allInstances,
                        madeInClient
                      );

                      return allInstances;

                    });

                }

                return deliveredPromise;

              },

            };

          }
        );

        // --------------------------------------------
        // 4. 返回 OHIF 所需的数据结构
        // --------------------------------------------

        if (returnPromises) {

          return seriesPromises;

        }

        // 非延迟加载模式
        await Promise.all(

          seriesPromises.map(promise =>
            promise.start()
          )

        );

        return seriesMetadata;

      },

    },

  };

  // --------------------------------------------------
  // DisplaySet ImageIds
  // --------------------------------------------------

  /**
   * 获取 DisplaySet 的 ImageIds
   */
  function getImageIdsForDisplaySet(displaySet) {

    const imageIds = [];

    if (!displaySet.images) {
      return imageIds;
    }

    displaySet.images.forEach(instance => {

      const numberOfFrames =
        Number(instance.NumberOfFrames) || 1;

      for (
        let frame = 0;
        frame < numberOfFrames;
        frame++
      ) {

        imageIds.push(

          getZBImageId(

            instance,

            numberOfFrames > 1
              ? frame
              : undefined

          )

        );

      }

    });

    return imageIds;

  }

  /**
   * 获取单个 Instance 的 ImageId
   */
  function getImageIdsForInstance({ instance, frame }) {

    return getZBImageId(instance, frame);

  }

  // --------------------------------------------------
  // DataSource Implementation
  // --------------------------------------------------

  const implementation = {

    initialize,

    query: queryAPI,

    retrieve: retrieveAPI,

    store: {

      dicom: () => {

        console.warn(
          'ZBDataSource: DICOM store is not implemented.'
        );

      },

    },

    reject: {},

    deleteStudyMetadataPromise: () => {},

    getImageIdsForDisplaySet,

    getImageIdsForInstance,

    getStudyInstanceUIDs: ({ query }) => {

      const studyUID =
        query.get('studyuid') ||
        query.get('StudyInstanceUID');

      return studyUID ? [studyUID] : [];

    },

    getConfig: () => dataSourceConfig,

  };

  return IWebApiDataSource.create(implementation);

}

export default createZBDataSource;
