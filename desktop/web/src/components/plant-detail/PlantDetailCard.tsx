import { useSignal, useSignalEffect } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { t } from '../../i18n';
import { locale } from '../../app/settings/state';
import {
  closePlantDetail,
  createPlantDetailController,
  isPlantDetailFavorite,
  resolvePlantDetailName,
  togglePlantDetailFavorite,
} from '../../app/plant-detail';
import type { SpeciesDetail } from '../../types/species';
import { favoriteLockedReason } from '../plant-db/PlantRow';
import { DetailTags, FactsGrid, OtherNames } from '../species-detail/FactsGrid';
import { SpeciesDetailLayout } from '../species-detail/SpeciesDetailLayout';
import { formatNumber } from '../species-detail/species-facts';
import speciesStyles from '../species-detail/SpeciesDetail.module.css';
import { CollapsibleSection } from './CollapsibleSection';
import { desktopSpeciesFacts, speciesUseTags } from './detail-facts';
import { PhotoCarousel } from './PhotoCarousel';
import { RiskDistributionSection } from './RiskDistributionSection';
import { Attr, BoolChip, NumAttr, formatPrecipRange } from './section-helpers';
import { UsesSection } from './UsesSection';
import styles from './PlantDetail.module.css';

interface Props {
  canonicalName: string;
}

/** Desktop species detail: the shared header, facts and footer over the full plant DB record. */
export function PlantDetailCard({ canonicalName }: Props) {
  const detailController = useMemo(() => createPlantDetailController(), []);
  const expanded = useSignal<Set<string>>(new Set());
  const namesExpanded = useSignal(false);

  useSignalEffect(() => {
    detailController.setTarget(resolvePlantDetailName(canonicalName), locale.value);
  });

  useEffect(() => () => detailController.dispose(), [detailController]);

  const effectiveName = resolvePlantDetailName(canonicalName);
  const loadState = detailController.loadState.value;
  const d = loadState === 'loaded' ? detailController.detail.value : null;
  const commonName = d?.common_name?.trim() || null;
  const englishName = detailController.englishName.value;
  const title = commonName ?? englishName ?? effectiveName;

  const toggle = (id: string) => {
    const next = new Set(expanded.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded.value = next;
  };

  return (
    <SpeciesDetailLayout
      identity={{
        canonicalName: effectiveName,
        commonName,
        englishName,
        family: d?.family ?? null,
        habitKey: detailController.habitKey.value,
      }}
      favorite={isPlantDetailFavorite(effectiveName)}
      favoriteLockedReason={favoriteLockedReason()}
      onToggleFavorite={() => { void togglePlantDetailFavorite(effectiveName); }}
      onBack={closePlantDetail}
      place={d ? { canonical_name: d.canonical_name, common_name: d.common_name, stratum: null, width_max_m: d.width_max_m } : null}
    >
      {loadState === 'loading' && (
        <p className={speciesStyles.status} aria-live="polite" aria-busy="true">{t('plantDetail.loading')}</p>
      )}
      {loadState === 'error' && (
        <div className={speciesStyles.statusError} role="alert">
          <span>{t('plantDetail.error')}: {detailController.errorMessage.value}</span>
          <button type="button" className={speciesStyles.linkButton} onClick={() => detailController.retry()}>
            {t('plantDetail.retry')}
          </button>
        </div>
      )}
      {d && (
        <>
          <PhotoCarousel canonicalName={d.canonical_name} name={title} />
          <OtherNames
            names={detailController.secondaryNames.value.map((entry) => entry.name).filter((name) => name !== title)}
            expanded={namesExpanded.value}
            onToggle={() => { namesExpanded.value = !namesExpanded.value; }}
          />
          <FactsGrid facts={desktopSpeciesFacts(d, locale.value)} />
          <DetailTags label={t('plantDetail.uses')} tags={speciesUseTags(d)} />
          <DetailSections d={d} expanded={expanded.value} onToggle={toggle} />
        </>
      )}
    </SpeciesDetailLayout>
  );
}

/** The full record in designer order; a section without recorded data does not render. */
function DetailSections({ d, expanded, onToggle }: { d: SpeciesDetail; expanded: Set<string>; onToggle: (id: string) => void }) {
  const hasUses = d.uses.length > 0 || d.edibility_rating !== null || d.medicinal_rating !== null
    || d.other_uses_rating !== null;

  const hasLifeCycle = d.is_annual !== null || d.is_biennial !== null || d.is_perennial !== null
    || d.lifespan !== null || d.deciduous_evergreen !== null || d.habit !== null
    || d.active_growth_period !== null || d.bloom_period !== null || d.flower_color !== null
    || d.leaf_retention !== null || d.pollinators !== null;

  const hasLight = d.tolerates_full_sun !== null || d.tolerates_semi_shade !== null
    || d.tolerates_full_shade !== null || d.frost_tender !== null || d.drought_tolerance !== null
    || d.frost_free_days_min !== null || d.precip_min_inches !== null || d.precip_max_inches !== null
    || d.climate_zones !== null;

  const hasSoil = d.soil_ph_min !== null || d.soil_ph_max !== null
    || d.well_drained !== null || d.heavy_clay !== null || d.tolerates_acid !== null
    || d.tolerates_alkaline !== null || d.tolerates_saline !== null || d.tolerates_wind !== null
    || d.tolerates_pollution !== null || d.tolerates_nutritionally_poor !== null
    || d.tolerates_light_soil !== null || d.tolerates_medium_soil !== null || d.tolerates_heavy_soil !== null
    || d.fertility_requirement !== null || d.moisture_use !== null
    || d.anaerobic_tolerance !== null || d.root_depth_min_cm !== null
    || d.salinity_tolerance !== null;

  const hasEcology = d.stratum !== null || d.succession_stage !== null || d.nitrogen_fixer !== null
    || d.attracts_wildlife !== null || d.scented !== null
    || d.ecological_system !== null || d.mycorrhizal_type !== null || d.grime_strategy !== null
    || d.raunkiaer_life_form !== null || d.cn_ratio !== null || d.allelopathic !== null
    || d.root_system_type !== null || d.taproot_persistent !== null
    || d.ellenberg_light !== null || d.ellenberg_temperature !== null
    || d.ellenberg_moisture !== null || d.ellenberg_reaction !== null
    || d.ellenberg_nitrogen !== null || d.ellenberg_salt !== null
    || d.photosynthesis_pathway !== null;

  const hasGrowthForm = d.growth_form_type !== null || d.growth_form_shape !== null
    || d.growth_habit !== null || d.woody !== null || d.canopy_position !== null
    || d.resprout_ability !== null || d.coppice_potential !== null
    || d.wood_density_g_cm3 !== null;

  const hasPropagation = d.propagated_by_seed !== null || d.propagated_by_cuttings !== null
    || d.propagated_by_bare_root !== null || d.propagated_by_container !== null
    || d.propagated_by_sprigs !== null || d.propagated_by_bulb !== null
    || d.propagated_by_sod !== null || d.propagated_by_tubers !== null
    || d.propagated_by_corm !== null || d.cold_stratification_required !== null
    || d.vegetative_spread_rate !== null || d.seed_spread_rate !== null
    || d.propagation_method !== null || d.sowing_period !== null
    || d.harvest_period !== null || d.dormancy_conditions !== null
    || d.management_types !== null;

  const hasFruitSeed = d.fruit_type !== null || d.fruit_seed_color !== null
    || d.fruit_seed_period_begin !== null || d.fruit_seed_period_end !== null
    || d.fruit_seed_abundance !== null || d.fruit_seed_persistence !== null
    || d.seed_mass_mg !== null || d.seed_length_mm !== null
    || d.seed_germination_rate !== null || d.seed_dispersal_mechanism !== null
    || d.seed_storage_behaviour !== null || d.seed_dormancy_type !== null
    || d.seed_dormancy_depth !== null || d.serotinous !== null
    || d.seedbank_type !== null;

  const hasLeaf = d.leaf_type !== null || d.leaf_compoundness !== null
    || d.leaf_shape !== null || d.sla_mm2_mg !== null || d.ldmc_g_g !== null
    || d.leaf_nitrogen_mg_g !== null || d.leaf_carbon_mg_g !== null
    || d.leaf_phosphorus_mg_g !== null || d.leaf_dry_mass_mg !== null;

  const hasReproduction = d.pollination_syndrome !== null || d.sexual_system !== null
    || d.mating_system !== null || d.self_fertile !== null
    || d.reproductive_type !== null || d.clonal_growth_form !== null || d.storage_organ !== null;

  const hasIdentity = d.taxonomic_order !== null || d.taxonomic_class !== null || d.is_hybrid !== null
    || d.genus !== null;

  const n = (value: number) => formatNumber(value, locale.value);
  const phStr =
    d.soil_ph_min !== null && d.soil_ph_max !== null
      ? `${n(d.soil_ph_min)}–${n(d.soil_ph_max)}`
      : d.soil_ph_min !== null
        ? `${n(d.soil_ph_min)}+`
        : d.soil_ph_max !== null
          ? `≤${n(d.soil_ph_max)}`
          : null;

  return (
    <div className={styles.sections}>
      {hasUses && (
        <CollapsibleSection id="uses" titleKey="plantDetail.useNotes" expanded={expanded} onToggle={onToggle}>
          <UsesSection
            uses={d.uses}
            edibilityRating={d.edibility_rating}
            medicinalRating={d.medicinal_rating}
            otherUsesRating={d.other_uses_rating}
          />
        </CollapsibleSection>
      )}

      {hasLifeCycle && (
        <CollapsibleSection id="lifeCycle" titleKey="plantDetail.lifeCycle" expanded={expanded} onToggle={onToggle}>
          <ul className={styles.boolRow}>
            <BoolChip label={t('plantDetail.annual')} value={d.is_annual} />
            <BoolChip label={t('plantDetail.biennial')} value={d.is_biennial} />
            <BoolChip label={t('plantDetail.perennial')} value={d.is_perennial} />
            <BoolChip label={t('plantDetail.leafRetention')} value={d.leaf_retention} />
          </ul>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.habit')} value={d.habit} />
            <Attr label={t('plantDetail.lifespan')} value={d.lifespan} />
            <Attr label={t('plantDetail.deciduousEvergreen')} value={d.deciduous_evergreen} />
            <Attr label={t('plantDetail.activeGrowth')} value={d.active_growth_period} />
            <Attr label={t('plantDetail.bloomPeriod')} value={d.bloom_period} />
            <Attr label={t('plantDetail.flowerColor')} value={d.flower_color} />
            <Attr label={t('plantDetail.pollinators')} value={d.pollinators} />
          </dl>
        </CollapsibleSection>
      )}

      {hasLight && (
        <CollapsibleSection id="light" titleKey="plantDetail.lightClimate" expanded={expanded} onToggle={onToggle}>
          <ul className={styles.boolRow} aria-label={t('plantDetail.sunTolerance')}>
            <BoolChip label={t('plantDetail.fullSun')} value={d.tolerates_full_sun} />
            <BoolChip label={t('plantDetail.semiShade')} value={d.tolerates_semi_shade} />
            <BoolChip label={t('plantDetail.fullShade')} value={d.tolerates_full_shade} />
            <BoolChip label={t('plantDetail.frostTender')} value={d.frost_tender} />
          </ul>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.droughtTolerance')} value={d.drought_tolerance} />
            <NumAttr label={t('plantDetail.frostFreeDays')} value={d.frost_free_days_min} unit={` ${t('plantDetail.daysUnit')}`} />
            <Attr label={t('plantDetail.precipRange')} value={formatPrecipRange(d.precip_min_inches, d.precip_max_inches)} />
            <Attr label={t('plantDetail.climateZones')} value={d.climate_zones} />
          </dl>
        </CollapsibleSection>
      )}

      {hasSoil && (
        <CollapsibleSection id="soil" titleKey="plantDetail.soil" expanded={expanded} onToggle={onToggle}>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.soilPh')} value={phStr} />
            <Attr label={t('plantDetail.fertilityRequirement')} value={d.fertility_requirement} />
            <Attr label={t('plantDetail.moistureUse')} value={d.moisture_use} />
            <Attr label={t('plantDetail.anaerobicTolerance')} value={d.anaerobic_tolerance} />
            <Attr label={t('plantDetail.salinityTolerance')} value={d.salinity_tolerance} />
            <NumAttr label={t('plantDetail.rootDepth')} value={d.root_depth_min_cm} unit=" cm" />
          </dl>
          <ul className={styles.boolRow}>
            <BoolChip label={t('plantDetail.wellDrained')} value={d.well_drained} />
            <BoolChip label={t('plantDetail.heavyClay')} value={d.heavy_clay} />
            <BoolChip label={t('plantDetail.toleratesLightSoil')} value={d.tolerates_light_soil} />
            <BoolChip label={t('plantDetail.toleratesMediumSoil')} value={d.tolerates_medium_soil} />
            <BoolChip label={t('plantDetail.toleratesHeavySoil')} value={d.tolerates_heavy_soil} />
            <BoolChip label={t('plantDetail.toleratesAcid')} value={d.tolerates_acid} />
            <BoolChip label={t('plantDetail.toleratesAlkaline')} value={d.tolerates_alkaline} />
            <BoolChip label={t('plantDetail.toleratesSaline')} value={d.tolerates_saline} />
            <BoolChip label={t('plantDetail.toleratesWind')} value={d.tolerates_wind} />
            <BoolChip label={t('plantDetail.toleratesPollution')} value={d.tolerates_pollution} />
            <BoolChip label={t('plantDetail.toleratesPoorSoil')} value={d.tolerates_nutritionally_poor} />
          </ul>
        </CollapsibleSection>
      )}

      {hasEcology && (
        <CollapsibleSection id="ecology" titleKey="plantDetail.ecology" expanded={expanded} onToggle={onToggle}>
          <ul className={styles.boolRow}>
            <BoolChip label={t('plantDetail.nitrogenFixer')} value={d.nitrogen_fixer} />
            <BoolChip label={t('plantDetail.attractsWildlife')} value={d.attracts_wildlife} />
            <BoolChip label={t('plantDetail.scented')} value={d.scented} />
            <BoolChip label={t('plantDetail.allelopathic')} value={d.allelopathic} />
            <BoolChip label={t('plantDetail.taprootPersistent')} value={d.taproot_persistent} />
          </ul>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.ecologicalSystem')} value={d.ecological_system} />
            <Attr label={t('plantDetail.mycorrhizalType')} value={d.mycorrhizal_type} />
            <Attr label={t('plantDetail.grimeStrategy')} value={d.grime_strategy} />
            <Attr label={t('plantDetail.raunkiaerLifeForm')} value={d.raunkiaer_life_form} />
            <Attr label={t('plantDetail.cnRatio')} value={d.cn_ratio} />
            <Attr label={t('plantDetail.rootSystemType')} value={d.root_system_type} />
            <Attr label={t('plantDetail.photosynthesisPathway')} value={d.photosynthesis_pathway} />
            <NumAttr label={t('plantDetail.ellenbergLight')} value={d.ellenberg_light} />
            <NumAttr label={t('plantDetail.ellenbergTemperature')} value={d.ellenberg_temperature} />
            <NumAttr label={t('plantDetail.ellenbergMoisture')} value={d.ellenberg_moisture} />
            <NumAttr label={t('plantDetail.ellenbergReaction')} value={d.ellenberg_reaction} />
            <NumAttr label={t('plantDetail.ellenbergNitrogen')} value={d.ellenberg_nitrogen} />
            <NumAttr label={t('plantDetail.ellenbergSalt')} value={d.ellenberg_salt} />
          </dl>
        </CollapsibleSection>
      )}

      {hasGrowthForm && (
        <CollapsibleSection id="growthForm" titleKey="plantDetail.growthForm" expanded={expanded} onToggle={onToggle}>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.growthFormType')} value={d.growth_form_type} />
            <Attr label={t('plantDetail.growthFormShape')} value={d.growth_form_shape} />
            <Attr label={t('plantDetail.growthHabit')} value={d.growth_habit} />
            <Attr label={t('plantDetail.canopyPosition')} value={d.canopy_position} />
            <NumAttr label={t('plantDetail.woodDensity')} value={d.wood_density_g_cm3} unit=" g/cm³" />
          </dl>
          <ul className={styles.boolRow}>
            <BoolChip label={t('plantDetail.woody')} value={d.woody} />
            <BoolChip label={t('plantDetail.resproutAbility')} value={d.resprout_ability} />
            <BoolChip label={t('plantDetail.coppicePotential')} value={d.coppice_potential} />
          </ul>
        </CollapsibleSection>
      )}

      {hasPropagation && (
        <CollapsibleSection id="propagation" titleKey="plantDetail.propagation" expanded={expanded} onToggle={onToggle}>
          <ul className={styles.boolRow}>
            <BoolChip label={t('plantDetail.propagatedBySeed')} value={d.propagated_by_seed} />
            <BoolChip label={t('plantDetail.propagatedByCuttings')} value={d.propagated_by_cuttings} />
            <BoolChip label={t('plantDetail.propagatedByBareRoot')} value={d.propagated_by_bare_root} />
            <BoolChip label={t('plantDetail.propagatedByContainer')} value={d.propagated_by_container} />
            <BoolChip label={t('plantDetail.propagatedBySprigs')} value={d.propagated_by_sprigs} />
            <BoolChip label={t('plantDetail.propagatedByBulb')} value={d.propagated_by_bulb} />
            <BoolChip label={t('plantDetail.propagatedBySod')} value={d.propagated_by_sod} />
            <BoolChip label={t('plantDetail.propagatedByTubers')} value={d.propagated_by_tubers} />
            <BoolChip label={t('plantDetail.propagatedByCorm')} value={d.propagated_by_corm} />
            <BoolChip label={t('plantDetail.coldStratificationRequired')} value={d.cold_stratification_required} />
          </ul>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.propagationMethod')} value={d.propagation_method} />
            <Attr label={t('plantDetail.vegetativeSpreadRate')} value={d.vegetative_spread_rate} />
            <Attr label={t('plantDetail.seedSpreadRate')} value={d.seed_spread_rate} />
            <Attr label={t('plantDetail.sowingPeriod')} value={d.sowing_period} />
            <Attr label={t('plantDetail.harvestPeriod')} value={d.harvest_period} />
            <Attr label={t('plantDetail.dormancyConditions')} value={d.dormancy_conditions} />
            <Attr label={t('plantDetail.managementTypes')} value={d.management_types} />
          </dl>
        </CollapsibleSection>
      )}

      {hasFruitSeed && (
        <CollapsibleSection id="fruitSeed" titleKey="plantDetail.fruitSeed" expanded={expanded} onToggle={onToggle}>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.fruitType')} value={d.fruit_type} />
            <Attr label={t('plantDetail.fruitSeedColor')} value={d.fruit_seed_color} />
            <Attr label={t('plantDetail.fruitSeedPeriodBegin')} value={d.fruit_seed_period_begin} />
            <Attr label={t('plantDetail.fruitSeedPeriodEnd')} value={d.fruit_seed_period_end} />
            <Attr label={t('plantDetail.fruitSeedAbundance')} value={d.fruit_seed_abundance} />
            <NumAttr label={t('plantDetail.seedMass')} value={d.seed_mass_mg} unit=" mg" />
            <NumAttr label={t('plantDetail.seedLength')} value={d.seed_length_mm} unit=" mm" />
            <NumAttr label={t('plantDetail.seedGerminationRate')} value={d.seed_germination_rate} unit="%" />
            <Attr label={t('plantDetail.seedDispersalMechanism')} value={d.seed_dispersal_mechanism} />
            <Attr label={t('plantDetail.seedStorageBehaviour')} value={d.seed_storage_behaviour} />
            <Attr label={t('plantDetail.seedDormancyType')} value={d.seed_dormancy_type} />
            <Attr label={t('plantDetail.seedDormancyDepth')} value={d.seed_dormancy_depth} />
            <Attr label={t('plantDetail.seedbankType')} value={d.seedbank_type} />
          </dl>
          <ul className={styles.boolRow}>
            <BoolChip label={t('plantDetail.fruitSeedPersistence')} value={d.fruit_seed_persistence} />
            <BoolChip label={t('plantDetail.serotinous')} value={d.serotinous} />
          </ul>
        </CollapsibleSection>
      )}

      {hasLeaf && (
        <CollapsibleSection id="leaf" titleKey="plantDetail.leaf" expanded={expanded} onToggle={onToggle}>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.leafType')} value={d.leaf_type} />
            <Attr label={t('plantDetail.leafCompoundness')} value={d.leaf_compoundness} />
            <Attr label={t('plantDetail.leafShape')} value={d.leaf_shape} />
            <NumAttr label={t('plantDetail.sla')} value={d.sla_mm2_mg} unit=" mm²/mg" />
            <NumAttr label={t('plantDetail.ldmc')} value={d.ldmc_g_g} unit=" g/g" />
            <NumAttr label={t('plantDetail.leafNitrogen')} value={d.leaf_nitrogen_mg_g} unit=" mg/g" />
            <NumAttr label={t('plantDetail.leafCarbon')} value={d.leaf_carbon_mg_g} unit=" mg/g" />
            <NumAttr label={t('plantDetail.leafPhosphorus')} value={d.leaf_phosphorus_mg_g} unit=" mg/g" />
            <NumAttr label={t('plantDetail.leafDryMass')} value={d.leaf_dry_mass_mg} unit=" mg" />
          </dl>
        </CollapsibleSection>
      )}

      {hasReproduction && (
        <CollapsibleSection id="reproduction" titleKey="plantDetail.reproduction" expanded={expanded} onToggle={onToggle}>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.pollinationSyndrome')} value={d.pollination_syndrome} />
            <Attr label={t('plantDetail.sexualSystem')} value={d.sexual_system} />
            <Attr label={t('plantDetail.matingSystem')} value={d.mating_system} />
            <Attr label={t('plantDetail.reproductiveType')} value={d.reproductive_type} />
            <Attr label={t('plantDetail.clonalGrowthForm')} value={d.clonal_growth_form} />
            <Attr label={t('plantDetail.storageOrgan')} value={d.storage_organ} />
          </dl>
          <ul className={styles.boolRow}>
            <BoolChip label={t('plantDetail.selfFertile')} value={d.self_fertile} />
          </ul>
        </CollapsibleSection>
      )}

      <RiskDistributionSection d={d} expanded={expanded} onToggle={onToggle} />

      {hasIdentity && (
        <CollapsibleSection id="identity" titleKey="plantDetail.identity" expanded={expanded} onToggle={onToggle}>
          <dl className={styles.attrGrid}>
            <Attr label={t('plantDetail.genus')} value={d.genus} />
            <Attr label={t('plantDetail.taxonomicOrder')} value={d.taxonomic_order} />
            <Attr label={t('plantDetail.taxonomicClass')} value={d.taxonomic_class} />
          </dl>
          <ul className={styles.boolRow}>
            <BoolChip label={t('plantDetail.isHybrid')} value={d.is_hybrid} />
          </ul>
        </CollapsibleSection>
      )}
    </div>
  );
}
